import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { getAuthContextFromToken, requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'

// GET /api/chat/stream?orderId=...
// Streams assistant/tool events for the given order via SSE.
export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const orderId = url.searchParams.get('orderId') || ''
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    const tokenParam = url.searchParams.get('access_token')
    let auth = await getAuthContextFromToken(tokenParam)
    if (!auth) {
      try {
        auth = await requireAuthContext(req)
      } catch (error: any) {
        const status = Number(error?.statusCode) || 401
        return NextResponse.json({ error: 'not_authenticated' }, { status })
      }
    }

    const supabase = createAdminClient()
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    const encoder = new TextEncoder()
    let keepRunning = true
    // Use ISO timestamp for monotonic polling boundary
    // Start far in the past so we don't miss cards created just before the stream opens
    let lastSeenMsgAt = new Date(0).toISOString()
    let emittedQuote = false
    let haveQuoteMsg = false
    let lastSeenTitle: string | null = null
    let lastSeenUpdatedAt: string | null = null
    let lastViewerAssetId: string | null = null

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        function send(obj: any) {
          const payload = { ...(obj || {}), order_id: orderId }
          const chunk = `data: ${JSON.stringify(payload)}\n\n`
          controller.enqueue(encoder.encode(chunk))
        }

        // No initial user-visible message to reduce console noise

        // Optionally send a tiny history primer to help clients render quickly (followers may ignore)
        try {
          const { data: hrows } = await supabase
            .from('chat_messages')
            .select('id,role,type,content_json,created_at')
            .eq('order_id', orderId)
            .order('created_at', { ascending: true })
            .limit(40)
          if (Array.isArray(hrows) && hrows.length) {
            send({ role: 'assistant', type: 'history', content: { items: hrows } })
            lastSeenMsgAt = hrows[hrows.length - 1].created_at
            try {
              haveQuoteMsg = hrows.some((row: any) => row?.type === 'card.quote')
            } catch {}
          }
        } catch {}

        // Poller: new chat messages and order status/assets
        const poll = async () => {
          if (!keepRunning) return
          try {
            // 1) New assistant/tool messages
            const { data: msgs } = await supabase
              .from('chat_messages')
              .select('id,role,type,content_json,created_at')
              .eq('order_id', orderId)
              // gte guards against clock skew between server and DB
              .gte('created_at', lastSeenMsgAt)
              .order('created_at', { ascending: true })
              .limit(50)
            if (msgs && msgs.length) {
              lastSeenMsgAt = msgs[msgs.length - 1].created_at
              for (const m of msgs) {
                // Avoid echoing plain assistant text; chat POST stream handles those.
                if ((m.role === 'assistant' || m.role === 'tool') && m.type && m.type !== 'text') {
                  // De‑dupe viewer.focus by asset id across sources (chat messages vs. asset scan)
                  if (m.type === 'viewer.focus') {
                    const aid = (m.content_json && (m.content_json as any).asset_id) || null
                    if (aid && lastViewerAssetId === aid) {
                      continue
                    }
                    if (aid) lastViewerAssetId = aid
                  }
                  if (m.type === 'card.quote') haveQuoteMsg = true
                  send({ id: m.id, role: 'assistant', type: m.type, content: m.content_json || {} })
                }
              }
            }

            // 2) Order title update
            {
              const { data: orderRow } = await supabase
                .from('orders')
                .select('title,prompt_text,updated_at')
                .eq('id', orderId)
                .single()
              if (orderRow) {
                const titleNow: string = (orderRow.title ?? orderRow.prompt_text ?? '') || ''
                const updatedAtNow: string | null = orderRow.updated_at || null
                if (titleNow && (titleNow !== lastSeenTitle || (updatedAtNow && updatedAtNow !== lastSeenUpdatedAt))) {
                  lastSeenTitle = titleNow
                  lastSeenUpdatedAt = updatedAtNow
                  send({ role: 'assistant', type: 'order.updated', content: { title: titleNow, updated_at: updatedAtNow } })
                }
              }
            }

            // 3) Quote card (if order.quote_json present)
            if (!emittedQuote && !haveQuoteMsg) {
              const { data: order } = await supabase
                .from('orders')
                .select('quote_json,status')
                .eq('id', orderId)
                .single()
              const q = order?.quote_json
              if (q && typeof q === 'object' &&
                  typeof q.minutes === 'number' &&
                  typeof q.grams === 'number' &&
                  (typeof q.total_cents === 'number' || typeof q.price_cents === 'number')) {
                emittedQuote = true
                send({ role: 'assistant', type: 'card.quote', content: q })
              }
            }

            // 4) Viewer focus after repair (repaired_stl), or proxy/raw as fallback
            {
              const { data: assets } = await supabase
                .from('assets')
                .select('id,kind,url,created_at')
                .eq('order_id', orderId)
                .order('created_at', { ascending: true })
                .limit(200)
              // Prefer stabilized meshes only; avoid raw_* to prevent flicker and color/orientation surprises
              const pickNewest = (arr: any[] | null | undefined, predicate: (a:any)=>boolean) => {
                const list = Array.isArray(arr) ? arr : []
                for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) return list[i]
                return null
              }
              const newestSized = pickNewest(assets, (a: any) => a.kind === 'repaired_sized_stl')
              const newestRepaired = pickNewest(assets, (a: any) => a.kind === 'repaired_stl')
              const newestUpload = pickNewest(assets, (a: any) => a.kind === 'upload_stl' || a.kind === 'upload_obj' || a.kind === 'upload_glb')
              const pick = newestSized || newestRepaired || newestUpload
              if (pick?.url) {
                const allowed = new Set(['repaired_stl','repaired_sized_stl','three_mf'])
                if (allowed.has(pick.kind)) {
                  // Deduplicate by asset id to avoid repeating due to new signed URL tokens
                  if (pick.id !== lastViewerAssetId) {
                    lastViewerAssetId = pick.id
                    const url = await signedUrlOrDirect(pick.url)
                    const focusKind = pick.kind === 'three_mf' ? 'toolpath' : 'stl'
                    send({ role: 'assistant', type: 'viewer.focus', content: { kind: focusKind, url, asset_id: pick.id, asset_kind: pick.kind } })
                  }
                }
              }
            }
          } catch (e) {
            // ignore individual poll errors
          }
        }

        // Set up intervals
        const iv = setInterval(poll, 1200)
        const keepAlive = setInterval(() => {
          if (!keepRunning) return
          controller.enqueue(encoder.encode(`: ping\n\n`))
        }, 15000)

        // One immediate poll to reduce perceived latency
        await poll()

        // Close handler (browser disconnect)
        // @ts-ignore
        req.signal?.addEventListener('abort', () => {
          keepRunning = false
          clearInterval(iv)
          clearInterval(keepAlive)
          try { controller.close() } catch {}
        })
      },
      cancel() {
        keepRunning = false
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
