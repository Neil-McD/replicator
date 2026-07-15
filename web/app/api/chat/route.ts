import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect, ensureStorageBucket, signedUrlWithInfo, normalizeSupabaseUrl } from '@/lib/supabaseAdmin'
import { mirrorRemoteImageToStorage } from '@/lib/storage'
import { getOpenAI, DEFAULT_OPENAI_MODEL } from '@/lib/llm'
import { buildContextSnapshot } from '@/lib/context'
import { tools as TOOL_REGISTRY } from '@/lib/tools'
import { getT2IProvider } from '@/lib/providers/t2i'
import { getEditProvider } from '@/lib/providers/edit'
import { materializeSelectedImages } from '@/lib/materialize'
import { requireAuthContext, type AuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { requestDispatch, requestFabrication, requestSliceJob } from '@/lib/lifecycle'

export const runtime = 'nodejs'

type OAITool = {
  type: 'function'
  function: { name: string; description?: string; parameters?: any }
}

function toOpenAITools() : OAITool[] {
  return TOOL_REGISTRY.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema },
  }))
}

function buildBambuConnectLink(url: string): string {
  return `bambu-connect://import-file?file=${encodeURIComponent(url)}`
}

const SYSTEM_PROMPT = `
You are Atom — an AI Product Engineer and a friendly build partner.
Primary goal: carry out what the user asks with minimal friction, then guide them to fabrication when they are satisfied.

Operating principles
- Obey direct requests immediately. Launch the requested tool, then mention any missing input in the same short reply instead of waiting for confirmation.
- Default to the current selection. When the user references “this / that / it”, assume they mean the latest chosen concept or mesh; only ask if nothing is selected.
- Stay opportunistic. If the user pivots to a new idea (make/build/create/new/etc.), start a fresh visualization even if candidates or meshes already exist.
- Keep replies crisp and actionable, one or two sentences plus tool cards. Maintain printable expectations: single solid body, grounded base, upright orientation, metric sizing.

Progression cues
- Track satisfaction language (“looks good”, “that works”, “ready”, “ship it”, “perfect”). When a printable mesh exists and no quote is on record, run slice_and_quote automatically unless the user defers.
- After a quote is delivered, assume the next step is checkout or listing. Offer concise options (“Open checkout?”, “Stage a store card?”) while staying responsive to new edits.

Context and continuity
- Always ground actions in the current order. Use get_active_concept/context_refresh to resolve ambiguity, otherwise proceed with the latest chosen concept.
- Honor multi-step edits: concept_edit modifies the active concept; materialize_i23d turns that concept into a mesh; viewer_focus surfaces geometry/toolpaths when helpful.

Flow scaffolding
- First turn: keep it one warm sentence. Greet and ask what to build; skip canned concepts or examples unless the user asks.
- During exploration, replace candidates promptly when users request a new direction. No need to protect the old set — they can always ask to revert.

Attachment handling
- Pending uploads appear as attachments with labels (A1, A2…). Acknowledge them and wait for the user’s direction before launching tools.
- Use attachment_promote_concept when the user wants to use an attachment as the concept without edits (“make a concept of this image”).
- Use attachment_edit with the user’s prompt when they ask to tweak, clean up, or extract something from an attachment.
- Use attachment_generate_angles when they ask for front/back/side/multi-angle views derived from an attachment.
- Default to the most recent attachment if the user says “this image” without a label; otherwise respect explicit labels.

Iteration policy
- After concepts appear, suggest a selection or tweak, but prefer to act (edit or materialize) instead of asking for indices.
- When the user selects or implicitly references a concept, materialize_i23d without requesting an index if a chosen image exists.
- Once a stabilized mesh exists and the user indicates satisfaction or asks what’s next, proceed to slice_and_quote and report results.

Tool policy
- If no candidates exist and the user gives a prompt → visualize_generate({ prompt, n: 2, style: 'mechanical' }).
- If candidates exist and the user selects/identifies one or says “make this real” → materialize_i23d using the current selection when available.
- For “another angle/variant of this” → get_active_concept → concept_edit with a concise camera or detail hint.
- Use viewer_focus only with concrete asset URLs (stl/toolpath) and keep URLs out of plain chat.
- When asked about angles, use list_angles_for_active_concept/context_refresh to answer before asking the user.
- When pending attachments are referenced, pick the right attachment_* tool instead of materialize_i23d until a concept is ready.

Constraints
- Never invent prices; only reference slicer quotes. Use mm. Decline unsafe content (weapons/illegal/IP).
- Keep provider names, model versions, and infrastructure details internal; never expose them in chat.

Tone
- Approachable, confident, decisive. Act first, explain briefly, keep chatting warm.
`

const ATTACHMENT_PROMPT = 'Describe how you want Atom to use these images.'

export async function POST(req: Request) {
  try {
    let auth: AuthContext
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    const { orderId: requestedOrderId, message } = (await req.json().catch(() => ({}))) as { orderId?: string; message?: string }
    if (!requestedOrderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    if (!message || typeof message !== 'string') return NextResponse.json({ error: 'message required' }, { status: 400 })
    const orderId = requestedOrderId
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id,status')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    // Persist user message
    await supabase.from('chat_messages').insert({ order_id: orderId, role: 'user', type: 'text', content_json: { text: message } })

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        function send(obj: any) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        }
        async function persistAssistantText(text: string) {
          await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text } })
        }

        async function buildHistory() {
          const { data: rows } = await supabase
            .from('chat_messages')
            .select('role,type,content_json,created_at')
            .eq('order_id', orderId)
            .order('created_at', { ascending: true })
            .limit(100)
          const msgs: any[] = []
          for (const r of rows || []) {
            if ((r.role === 'user' || r.role === 'assistant') && r.type === 'text') {
              const t = r.content_json?.text || ''
              if (t) msgs.push({ role: r.role, content: t })
            } else if (r.role === 'assistant' && r.type === 'card.images') {
              const group = r.content_json?.group || null
              if (group === 'angles') {
                const labels = Array.isArray(r.content_json?.images) ? (r.content_json.images as any[]).map((x:any)=>x?.angle).filter(Boolean) : []
                const labelLine = labels.length ? `Angles ready (${labels.join('/')}).` : 'Angles ready.'
                msgs.push({ role: 'assistant', content: labelLine })
              } else {
                // Provide a compact textual breadcrumb so the LLM remembers that candidates exist
                const n = Number(r.content_json?.n || 0) || (Array.isArray(r.content_json?.images) ? r.content_json.images.length : 0)
                msgs.push({ role: 'assistant', content: `Candidates ready (${n}).` })
              }
            } else if (r.role === 'assistant' && r.type === 'card.attachments') {
              const list = Array.isArray(r.content_json?.attachments) ? r.content_json.attachments : []
              if (list.length) {
                const labels = list
                  .map((item: any) => (item?.label ? String(item.label) : null))
                  .filter(Boolean)
                const pending = list.filter((item: any) => item?.pending !== false).length
                const status = pending ? `${pending} pending` : 'all processed'
                const labelLine = labels.length ? labels.join(', ') : `${list.length} attachment(s)`
                msgs.push({ role: 'assistant', content: `Attachments available (${labelLine}; ${status}).` })
              }
            } else if (r.role === 'assistant' && r.type === 'card.job') {
              msgs.push({ role: 'assistant', content: 'Materializing the selected reference into a 3D mesh…' })
            } else if (r.role === 'assistant' && r.type === 'card.quote') {
              const q = r.content_json || {}
              const cents = (typeof q.total_cents === 'number' ? q.total_cents : (typeof q.price_cents === 'number' ? q.price_cents : null))
              const priceStr = typeof cents === 'number' ? `$${(cents/100).toFixed(2)}` : '—'
              const line = `Quote: ${q.minutes ?? '—'} min · ${q.grams ?? '—'} g · ${priceStr}`
              msgs.push({ role: 'assistant', content: line })
            }
          }
          // Inject a current-state breadcrumb so the LLM understands where we are, even if
          // previous assistant messages were not textual.
          try {
            const { data: orderRow } = await supabase.from('orders').select('status,quote_json').eq('id', orderId).single()
            const { data: assets } = await supabase
              .from('assets')
              .select('kind')
              .eq('order_id', orderId)
              .order('created_at', { ascending: true })
            const kinds = new Set((assets || []).map((a: any) => a.kind))
            const hasRepaired = kinds.has('repaired_stl')
            const hasThreeMF = kinds.has('three_mf')
            const hasProxy = kinds.has('proxy_stl')
            if (hasRepaired && !hasThreeMF) {
              msgs.push({ role: 'assistant', content: 'Mesh stabilized — preview available.' })
            }
            if (orderRow?.status === 'ready_to_pay' && orderRow?.quote_json) {
              const q = orderRow.quote_json
              const cents = (typeof q.total_cents === 'number' ? q.total_cents : (typeof q.price_cents === 'number' ? q.price_cents : null))
              const priceStr = typeof cents === 'number' ? `$${(cents/100).toFixed(2)}` : '—'
              msgs.push({ role: 'assistant', content: `Quote: ${q.minutes ?? '—'} min · ${q.grams ?? '—'} g · ${priceStr}` })
            }
            if (!hasRepaired && hasProxy) {
              msgs.push({ role: 'assistant', content: 'Draft proxy preview shown while the final mesh is preparing.' })
            }
          } catch {}
          // Ensure last user message is present
          if (!msgs.length || msgs[msgs.length-1].role !== 'user') {
            msgs.push({ role: 'user', content: message })
          }
          const attachments = await fetchAttachmentSummaries()
          if (attachments.length) {
            const hasExistingSummary = msgs.some((m) => m?.role === 'assistant' && typeof m?.content === 'string' && m.content.startsWith('Attachments available'))
            if (!hasExistingSummary) {
              const labels = attachments
                .map((item: any) => (item?.label ? String(item.label) : null))
                .filter(Boolean)
              const pending = attachments.filter((item: any) => item?.pending !== false).length
              const status = pending ? `${pending} pending` : 'all processed'
              const labelLine = labels.length ? labels.join(', ') : `${attachments.length} attachment(s)`
              msgs.push({ role: 'assistant', content: `Attachments available (${labelLine}; ${status}).` })
            }
          }
          return msgs
        }

        async function fetchAttachmentSummaries() {
          const signTtl = Math.max(60, Number(process.env.SIGNED_URL_TTL_S || 900))
          const { data } = await supabase
            .from('assets')
            .select('id,url,meta_json,created_at')
            .eq('order_id', orderId)
            .eq('kind', 'upload_image')
            .order('created_at', { ascending: true })
            .limit(50)
          const attachments: any[] = []
          for (const row of data || []) {
            let canonical = row.url as string
            try { canonical = normalizeSupabaseUrl(row.url) || row.url } catch {}
            let signed: Awaited<ReturnType<typeof signedUrlWithInfo>> | null = null
            try { signed = await signedUrlWithInfo(canonical, signTtl) } catch {}
            const meta = (row.meta_json || {}) as Record<string, any>
            const origin = typeof meta?.origin === 'string' ? meta.origin : null
            if (origin && origin !== 'user_upload') {
              continue
            }
            attachments.push({
              asset_id: row.id,
              storage_url: canonical,
              url: signed?.url || canonical,
              expires_at: signed?.expiresAt ?? null,
              label: typeof meta?.label === 'string' ? meta.label : null,
              pending: typeof meta?.pending === 'boolean' ? meta.pending : null,
              name: typeof meta?.name === 'string' ? meta.name : null,
              size: typeof meta?.size === 'number' ? meta.size : null,
              content_type: typeof meta?.type === 'string' ? meta.type : null,
            })
          }
          return attachments
        }

        async function broadcastAttachmentUpdate(prompt?: string) {
          const attachments = await fetchAttachmentSummaries()
          const content = {
            prompt: prompt || ATTACHMENT_PROMPT,
            attachments,
          }
          send({ role: 'assistant', type: 'attachments.update', content })
          return attachments
        }

        async function promoteAttachments(assetIds: string[]): Promise<any[]> {
          const tokens = Array.from(
            new Set((assetIds || []).map((id) => (id ? String(id) : '').trim()).filter(Boolean))
          )
          if (!tokens.length) throw new Error('assetIds required')

          const { data: availableAssets, error: assetsErr } = await supabase
            .from('assets')
            .select('id,kind,url,meta_json')
            .eq('order_id', orderId)
            .eq('kind', 'upload_image')
            .order('created_at', { ascending: true })
            .limit(100)
          if (assetsErr) throw assetsErr

          const idMap = new Map<string, any>()
          const labelMap = new Map<string, any>()
          for (const row of availableAssets || []) {
            idMap.set(row.id as string, row)
            const meta = (row?.meta_json || {}) as Record<string, any>
            const label = typeof meta?.label === 'string' ? meta.label.trim() : ''
            if (label) {
              labelMap.set(label, row)
              labelMap.set(label.toLowerCase(), row)
            }
          }

          const resolved: any[] = []
          const seenIds = new Set<string>()
          for (const token of tokens) {
            const match = idMap.get(token) || labelMap.get(token) || labelMap.get(token.toLowerCase())
            if (match && !seenIds.has(match.id)) {
              resolved.push(match)
              seenIds.add(match.id)
            }
          }

          if (!resolved.length) throw new Error('no_upload_assets')

          const insertRows = resolved.map((row: any) => {
            const meta = (row?.meta_json || {}) as Record<string, any>
            const payload: Record<string, any> = {
              source_asset_id: row.id,
              origin: 'attachment_promote',
            }
            if (meta?.label) payload.attachment_label = meta.label
            return {
              order_id: orderId,
              kind: 'candidate' as const,
              url: row.url as string,
              meta_json: payload,
            }
          })

          const { data: inserted, error: insertErr } = await supabase
            .from('images')
            .insert(insertRows)
            .select('id,url,meta_json')
          if (insertErr) throw insertErr

          await supabase.from('orders').update({ status: 'await_image_pick' }).eq('id', orderId)
          try {
            await supabase.from('order_events').insert({
              order_id: orderId,
              phase: 'visualizing',
              message: `Promoted ${insertRows.length} attachment(s) to concepts`,
              meta_json: { asset_ids: resolved.map((row: any) => row.id), tokens },
            })
          } catch {}

          await Promise.all(
            resolved.map(async (row: any) => {
              const meta = { ...(row?.meta_json || {}) }
              meta.pending = false
              meta.promoted = true
              await supabase.from('assets').update({ meta_json: meta }).eq('id', row.id)
            })
          )

          return inserted || []
        }

        let openai: ReturnType<typeof getOpenAI> | null = null
        try {
          openai = getOpenAI()
        } catch (e: any) {
          // No API key or client init failed — graceful fallback: try to generate concepts directly.
          try {
            const { data: existing } = await supabase
              .from('images')
              .select('id')
              .eq('order_id', orderId)
              .limit(1)
            if (!existing || existing.length === 0) {
              const provider = getT2IProvider(process.env.T2I_PROVIDER)
              const n = 2
              const style = 'mechanical' as const
              const { imageUrls } = await provider.generateImages({ prompt: (message || '').toString(), n, style })
              if (imageUrls && imageUrls.length) {
                const rows = imageUrls.map((url) => ({ order_id: orderId, kind: 'candidate', url, meta_json: { prompt: message, style } }))
                const { data: inserted } = await supabase.from('images').insert(rows).select('id,url')
                await supabase.from('orders').update({ status: 'await_image_pick' }).eq('id', orderId)
                const cardImages = [] as any[]
                for (const r of inserted || []) {
                  const canonical = normalizeSupabaseUrl(r.url) || r.url
                  const signed = await signedUrlWithInfo(canonical)
                  cardImages.push({
                    id: r.id,
                    url: signed.url,
                    storage_url: canonical,
                    expires_at: signed.expiresAt ?? null,
                  })
                }
                await supabase.from('chat_messages').insert({
                  order_id: orderId,
                  role: 'assistant',
                  type: 'card.images',
                  content_json: { prompt: message, style, images: cardImages, n },
                })
              }
            }
            const txt = 'Generating concepts… pick one to materialize.'
            send({ role: 'assistant', type: 'text', content: { text: txt } })
            await persistAssistantText(txt)
          } catch {
            const fallback = 'Tell me what to make and I will generate concepts.'
            send({ role: 'assistant', type: 'text', content: { text: fallback } })
            await persistAssistantText(fallback)
          }
          controller.close();
          return
        }

        async function callLLM(messages: any[]) {
          // Use the configured model only (or default), no implicit downgrades
          const model = (process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL || 'gpt-5-mini-2025-08-07') as string
          const timeoutMs = Math.max(5000, Number(process.env.LLM_TIMEOUT_MS || 15000))
          let lastErr: any = null

          // Build snapshot once per call and attach facts/vision
            const maxImages = Math.max(1, Math.min(8, Number(process.env.CONTEXT_MAX_IMAGES || 4)))
            const maxAngles = Math.max(1, Math.min(6, Number(process.env.CONTEXT_MAX_ANGLES || 3)))
            let snap: any = null
            try { snap = await buildContextSnapshot(orderId, { maxImages, maxAngles }) } catch {}
            if (snap) {
              messages = [
                { role: 'system', content: `FACTS: ${JSON.stringify({ status: snap.status, quote: snap.quote, selected_image_id: snap.selected_image_id, chosen_index: snap.chosen_index, images: (snap.images||[]).map((x: any)=>x.id).slice(0, maxImages), angles: (snap.angles||[]).map((a: any)=>({ parent_image_id:a.parent_image_id, parent_index:a.parent_index||null, labels:a.labels, image_ids:a.image_ids })), last_angles_parent_id: snap.last_angles_parent_id||null, has_stl: !!snap.geometry?.stl_url })}` },
                ...messages,
              ]
            }
          const vision = String(process.env.LLM_VISION || '0').trim().toLowerCase() as string
          let visionMsg: any | null = null
          if (['1','true','yes','on'].includes(vision) && snap) {
            // Only attach images when the user likely asked to see/compare/angle
            let lastUserText = ''
            try {
              for (let i = messages.length - 1; i >= 0; i--) { const m:any = messages[i]; if (m?.role === 'user' && typeof m?.content === 'string') { lastUserText = m.content.toLowerCase(); break } }
            } catch {}
            const wantsVision = /\b(see|show|look|view|compare|angle|photo|image|preview|model)\b/.test(lastUserText)
            if (!wantsVision) {
              // Skip attaching vision to reduce latency when not needed
            } else {
            try {
              const parts: any[] = []
              parts.push({ type: 'text', text: 'Context images and previews for this order.' })
              // If angles exist for the latest/active parent, show them first
              let attachedAngles = false
              try {
                const targetParent = snap.last_angles_parent_id || snap.selected_image_id || null
                if (targetParent) {
                  const grp = (snap.angles || []).find((a:any)=>a.parent_image_id===targetParent)
                  if (grp && Array.isArray(grp.images) && grp.images.length) {
                    const idx = grp.parent_index ? `C${grp.parent_index}` : 'the selected concept'
                    const labelLine = grp.labels && grp.labels.length ? `Angles for ${idx}: ${grp.labels.join('/')}.` : `Angles for ${idx}.`
                    parts.push({ type: 'text', text: labelLine })
                    for (const img of grp.images.slice(0, Math.max(1, Math.min(6, Number(process.env.CONTEXT_MAX_ANGLES || 3))))) {
                      parts.push({ type: 'image_url', image_url: { url: img.url } })
                    }
                    attachedAngles = true
                  }
                }
              } catch {}
              // Then include recent concept images (up to maxImages)
              for (const im of (snap.images || []).slice(0, maxImages)) parts.push({ type: 'image_url', image_url: { url: im.url } })
              const preview = snap.geometry?.preview_url || snap.toolpath?.preview_url
              if (preview) parts.push({ type: 'image_url', image_url: { url: preview } })
              if (parts.length > 1) visionMsg = { role: 'user', content: parts }
            } catch {}
            }
          }
          const baseMsgs = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
          const finalMsgs = visionMsg ? [...baseMsgs, visionMsg] : baseMsgs

          // One quick retry with small backoff to avoid transient timeouts
          const attempts = 2
          for (let i = 0; i < attempts; i++) {
            try {
              const p = openai!.chat.completions.create({ model, messages: finalMsgs as any, tools: toOpenAITools(), tool_choice: 'auto' })
              const withTimeout = new Promise<any>((resolve, reject) => {
                const t = setTimeout(() => reject(new Error('llm_timeout')), timeoutMs)
                p.then((v:any) => { clearTimeout(t); resolve(v) }).catch((e:any) => { clearTimeout(t); reject(e) })
              })
              return await withTimeout
            } catch (e: any) {
              lastErr = e
              try { await supabase.from('order_events').insert({ order_id: orderId, phase: 'llm_error', message: (e?.message || 'error') + (i === 0 ? ' (retrying)' : '') }) } catch {}
              if (i === 0) {
                await new Promise(r => setTimeout(r, Math.min(1500, Math.floor(timeoutMs * 0.1))))
                continue
              }
            }
          }
          // All model attempts failed: emit a graceful, non-resetting text and stop
          const txt = 'Model is briefly unavailable. Your design is intact — I can size it, slice a quote, or tweak it.'
          send({ role: 'assistant', type: 'text', content: { text: txt } })
          await persistAssistantText(txt)
          throw lastErr || new Error('llm_unavailable')
        }

        async function adapter_visualize_generate(args: any) {
          // Clear cancel flag on new visualize to resume pipeline after a refresh-cancel
          try {
            const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
            const prev = (row?.meta_json as any) || {}
            const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
            await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
          } catch {}
          const prompt: string = (args?.prompt || message || '').toString()
          const style = args?.style
          const provider = getT2IProvider(process.env.T2I_PROVIDER)
          const { imageUrls } = await provider.generateImages({ prompt, n: 2, style })
          // Mirror to storage for reliability
          const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
          try { await ensureStorageBucket(bucket) } catch {}
          const mirrored: { url: string }[] = []
          for (const u of (imageUrls || [])) {
            try {
              const res = await fetch(u); if (!res.ok) throw new Error(`fetch ${res.status}`)
              const ab = await res.arrayBuffer(); const b = Buffer.from(ab)
              const ct = (res.headers.get('content-type') || 'image/jpeg').toLowerCase()
              const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
              const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
              const path = `generated/${orderId}/${name}`
              const up = await supabase.storage.from(bucket).upload(path, b, { upsert: true, contentType: ct })
              if (up.error) throw up.error
              mirrored.push({ url: `supabase://${bucket}/${path}` })
            } catch { mirrored.push({ url: u }) }
          }
          const rows = mirrored.map((it) => ({ order_id: orderId, kind: 'candidate', url: it.url, meta_json: { prompt, style } }))
          const { data: inserted, error } = await supabase
            .from('images')
            .insert(rows)
            .select('id,url')
          if (error) throw error
          await supabase.from('orders').update({ status: 'await_image_pick' }).eq('id', orderId)
          const indexed = [] as any[]
          for (let i = 0; i < (inserted || []).length; i++) {
            const row = inserted![i]
            const canonical = normalizeSupabaseUrl(row.url) || row.url
            const signed = await signedUrlWithInfo(canonical)
            indexed.push({
              id: row.id,
              index: i + 1,
              url: signed.url,
              storage_url: canonical,
              expires_at: signed.expiresAt ?? null,
            })
          }
          await supabase
            .from('chat_messages')
            .insert({ order_id: orderId, role: 'assistant', type: 'card.images', content_json: { prompt, style: style || null, images: indexed, n: indexed.length } })
          const pickText = 'Pick a concept to materialize.'
          await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: pickText } })
          send({ role: 'assistant', type: 'text', content: { text: pickText } })
          return { images: inserted || [] }
        }

        async function adapter_attachment_promote(args: any) {
          const assetIds: string[] = Array.isArray(args?.assetIds) ? args.assetIds.map((x: any) => String(x)).filter(Boolean) : []
          if (!assetIds.length) throw new Error('assetIds required')
          const inserted = await promoteAttachments(assetIds)
          const images: any[] = []
          for (let i = 0; i < inserted.length; i++) {
            const row = inserted[i]
            const canonical = normalizeSupabaseUrl(row.url) || row.url
            const signed = await signedUrlWithInfo(canonical)
            images.push({
              id: row.id,
              index: i + 1,
              url: signed.url,
              storage_url: canonical,
              expires_at: signed.expiresAt ?? null,
            })
          }
          if (images.length) {
            await supabase
              .from('chat_messages')
              .insert({
                order_id: orderId,
                role: 'assistant',
                type: 'card.images',
                content_json: { prompt: 'Attachment promoted', images, n: images.length },
              })
            const txt = images.length > 1 ? 'Attachments staged as concepts — pick one to continue.' : 'Attachment staged as a concept — pick it to continue.'
            await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: txt } })
            send({ role: 'assistant', type: 'text', content: { text: txt } })
          }
          await broadcastAttachmentUpdate()
          return { images }
        }

        async function adapter_attachment_edit(args: any) {
          const assetId = typeof args?.assetId === 'string' ? args.assetId : String(args?.assetId || '')
          const prompt: string = (args?.prompt || '').toString().trim()
          if (!assetId) throw new Error('assetId required')
          if (!prompt) throw new Error('prompt required')
          const n = Math.max(1, Math.min(4, Number(args?.n) || 2))
          const format: 'jpeg' | 'png' = args?.format === 'png' ? 'png' : 'jpeg'

          const { data: assetRow, error: assetErr } = await supabase
            .from('assets')
            .select('id,kind,url,meta_json')
            .eq('order_id', orderId)
            .eq('id', assetId)
            .single()
          if (assetErr || !assetRow) throw new Error('asset_not_found')
          if (assetRow.kind !== 'upload_image') throw new Error('asset_not_image')
          let sourceUrl = assetRow.url as string
          try { sourceUrl = await signedUrlOrDirect(assetRow.url) } catch {}
          const editor = getEditProvider(process.env.EDIT_PROVIDER)
          const { imageUrls, description } = await editor.editImage({ imageUrl: sourceUrl, prompt, n, format })
          if (!imageUrls || !imageUrls.length) throw new Error('edit_returned_no_images')
          const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
          const mirrored: string[] = []
          for (const url of imageUrls.slice(0, n)) {
            const stored = await mirrorRemoteImageToStorage(supabase, url, { bucket, prefix: `edits/${orderId}` })
            mirrored.push(stored)
          }
          const meta = (assetRow.meta_json || {}) as Record<string, any>
          const rows = mirrored.map((url) => ({
            order_id: orderId,
            kind: 'candidate',
            url,
            meta_json: {
              source_asset_id: assetRow.id,
              attachment_label: meta?.label || null,
              origin: 'attachment_edit',
              edit_prompt: prompt,
              description: description || null,
            },
          }))
          const { data: inserted, error: insertErr } = await supabase
            .from('images')
            .insert(rows)
            .select('id,url')
          if (insertErr) throw insertErr
          await supabase.from('orders').update({ status: 'await_image_pick' }).eq('id', orderId)
          try {
            await supabase.from('order_events').insert({
              order_id: orderId,
              phase: 'visualizing',
              message: `Edited attachment ${meta?.label || assetRow.id}`,
              meta_json: { asset_id: assetRow.id, prompt, n },
            })
          } catch {}
          const images: any[] = []
          for (const row of inserted || []) {
            const canonical = normalizeSupabaseUrl(row.url) || row.url
            const signed = await signedUrlWithInfo(canonical)
            images.push({
              id: row.id,
              url: signed.url,
              storage_url: canonical,
              expires_at: signed.expiresAt ?? null,
            })
          }
          await supabase
            .from('chat_messages')
            .insert({ order_id: orderId, role: 'assistant', type: 'card.images', content_json: { prompt, images, n: images.length } })
          const line = 'Edited concepts ready — pick one or ask for another tweak.'
          await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: line } })
          send({ role: 'assistant', type: 'text', content: { text: line } })

          const nextMeta = { ...meta, pending: false, edited: true, last_edit_prompt: prompt }
          await supabase.from('assets').update({ meta_json: nextMeta }).eq('id', assetRow.id)
          await broadcastAttachmentUpdate()
          return { images }
        }

        async function adapter_attachment_generate_angles(args: any) {
          const assetId = typeof args?.assetId === 'string' ? args.assetId : String(args?.assetId || '')
          if (!assetId) throw new Error('assetId required')
          const promptTail: string = (args?.prompt || '').toString().trim()
          const requestedAngles = Array.isArray(args?.angles) ? args.angles : []
          const allowedAngles = new Set(['front', 'back', 'left', 'right', 'top', 'bottom'])
          let angles = requestedAngles
            .map((a: any) => String(a || '').toLowerCase().trim())
            .filter((a: string) => allowedAngles.has(a))
          if (!angles.length) {
            angles = ['front', 'back', 'left', 'right']
          }

          const { data: assetRow, error: assetErr } = await supabase
            .from('assets')
            .select('id,kind,url,meta_json')
            .eq('order_id', orderId)
            .eq('id', assetId)
            .single()
          if (assetErr || !assetRow) throw new Error('asset_not_found')
          if (assetRow.kind !== 'upload_image') throw new Error('asset_not_image')

          const label = (assetRow.meta_json as any)?.label || null

          const { data: existingConcepts } = await supabase
            .from('images')
            .select('id,url,meta_json,created_at')
            .eq('order_id', orderId)
            .filter('meta_json->>source_asset_id', 'eq', assetId)
            .order('created_at', { ascending: true })

          let parentImageId: string | null = null
          let parentInserted: any[] | null = null
          if (existingConcepts && existingConcepts.length) {
            parentImageId = existingConcepts[existingConcepts.length - 1].id as string
          } else {
            parentInserted = await promoteAttachments([assetId])
            parentImageId = parentInserted[0]?.id || null
          }
          if (!parentImageId) throw new Error('parent_image_missing')

          if (parentInserted && parentInserted.length) {
            const conceptImages: any[] = []
            for (let i = 0; i < parentInserted.length; i++) {
              const row = parentInserted[i]
              const canonical = normalizeSupabaseUrl(row.url) || row.url
              const signed = await signedUrlWithInfo(canonical)
              conceptImages.push({
                id: row.id,
                index: i + 1,
                url: signed.url,
                storage_url: canonical,
                expires_at: signed.expiresAt ?? null,
              })
            }
            if (conceptImages.length) {
              await supabase
                .from('chat_messages')
                .insert({
                  order_id: orderId,
                  role: 'assistant',
                  type: 'card.images',
                  content_json: { prompt: 'Attachment promoted', images: conceptImages, n: conceptImages.length },
                })
              const txt = 'Attachment staged as a concept before generating angles.'
              await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: txt } })
              send({ role: 'assistant', type: 'text', content: { text: txt } })
            }
          }

          let sourceUrl = assetRow.url as string
          try { sourceUrl = await signedUrlOrDirect(assetRow.url) } catch {}
          const editor = getEditProvider(process.env.EDIT_PROVIDER)
          const anglePrompts: Record<string, string> = {
            front: 'render the same object — front three-quarter angle; centered; neutral studio background; no props; no text.',
            back: 'render the same object — rear three-quarter angle; centered; neutral studio background; no props; no text.',
            left: 'render the same object — left profile angle; centered; neutral studio background; no props; no text.',
            right: 'render the same object — right profile angle; centered; neutral studio background; no props; no text.',
            top: 'render the same object — top-down angle; centered; neutral studio background; no props; no text.',
            bottom: 'render the same object — underside/low angle; centered; neutral studio background; no props; no text.',
          }

          const angleRows: any[] = []
          for (const angle of angles) {
            const basePrompt = anglePrompts[angle] || anglePrompts.front
            const finalPrompt = promptTail ? `${basePrompt} ${promptTail}`.trim() : basePrompt
            const { imageUrls } = await editor.editImage({ imageUrl: sourceUrl, prompt: finalPrompt, n: 1, format: 'jpeg' })
            if (!imageUrls || !imageUrls.length) continue
            const stored = await mirrorRemoteImageToStorage(supabase, imageUrls[0], {
              bucket: process.env.SUPABASE_STORAGE_BUCKET || 'artifacts',
              prefix: `angles/${orderId}`,
            })
            angleRows.push({
              order_id: orderId,
              kind: 'candidate',
              url: stored,
              meta_json: {
                parent_image_id: parentImageId,
                group: 'angles',
                angle,
                view_role: angle,
                origin: 'attachment_generate_angles',
                source_asset_id: assetId,
                attachment_label: label,
              },
            })
          }
          if (!angleRows.length) throw new Error('angle_generation_failed')

          const { data: insertedAngles, error: insertErr } = await supabase
            .from('images')
            .insert(angleRows)
            .select('id,url,meta_json')
          if (insertErr) throw insertErr

          try {
            await supabase.from('order_events').insert({
              order_id: orderId,
              phase: 'visualizing',
              message: `Generated ${insertedAngles.length} angle(s) from attachment`,
              meta_json: { asset_id: assetId, angles },
            })
          } catch {}

          const images: any[] = []
          for (const row of insertedAngles || []) {
            const canonical = normalizeSupabaseUrl(row.url) || row.url
            const signed = await signedUrlWithInfo(canonical)
            images.push({
              id: row.id,
              angle: row.meta_json?.angle || null,
              view_role: row.meta_json?.view_role || null,
              url: signed.url,
              storage_url: canonical,
              expires_at: signed.expiresAt ?? null,
            })
          }
          await supabase
            .from('chat_messages')
            .insert({
              order_id: orderId,
              role: 'assistant',
              type: 'card.images',
              content_json: { group: 'angles', parent_image_id: parentImageId, images, n: images.length },
            })
          const summary = `Angles ready (${angles.join('/')}).`
          await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: summary } })
          send({ role: 'assistant', type: 'text', content: { text: summary } })

          const meta = { ...(assetRow.meta_json || {}) }
          meta.pending = false
          meta.angles_generated = Array.from(new Set([...(Array.isArray(meta?.angles_generated) ? meta.angles_generated : []), ...angles]))
          await supabase.from('assets').update({ meta_json: meta }).eq('id', assetId)
          await broadcastAttachmentUpdate()
          return { images }
        }

        async function adapter_materialize_i23d(args: any) {
          const inputIds: string[] = Array.isArray(args?.imageIds) ? args.imageIds : []
          const inputUrls: string[] = Array.isArray(args?.imageUrls) ? args.imageUrls : []
          if (!inputIds.length && !inputUrls.length) throw new Error('imageIds required')

          const enableQuickMesh = ['1', 'true', 'yes', 'on'].includes(String(process.env.WEB_I23D_FALLBACK || '0').trim().toLowerCase())
          const result = await materializeSelectedImages({
            supabase,
            orderId,
            imageIds: inputIds,
            imageUrls: inputUrls,
            enableQuickMesh,
          })

          const card = { kind: 'i23d', images: result.uploaded.map((u) => ({ id: u.id, view_role: u.viewRole || null })) }
          try {
            const { data: recent } = await supabase
              .from('chat_messages')
              .select('id,created_at')
              .eq('order_id', orderId)
              .eq('type', 'card.job')
              .order('created_at', { ascending: false })
              .limit(1)
            if (!recent || recent.length === 0) {
              await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'card.job', content_json: card })
            }
          } catch {
            await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'card.job', content_json: card })
          }
          send({ role: 'assistant', type: 'card.job', content: card })

          if (result.angleImages && result.angleImages.length) {
            try {
              const images = await Promise.all(
                result.angleImages.map(async (angle) => {
                  const canonical = normalizeSupabaseUrl(angle.assetUrl) || angle.assetUrl
                  const signed = await signedUrlWithInfo(canonical)
                  return {
                    id: angle.id,
                    view_role: angle.viewRole || null,
                    url: signed.url,
                    storage_url: canonical,
                    expires_at: signed.expiresAt ?? null,
                  }
                })
              )
              await supabase.from('chat_messages').insert({
                order_id: orderId,
                role: 'assistant',
                type: 'card.images',
                content_json: { group: 'angles', parent_image_id: result.uploaded[0]?.id || null, images, n: images.length },
              })
            } catch {}
          }

          return { ok: true, selected: result.uploaded.length }
        }

        async function adapter_concept_edit(args: any) {
          const n = Math.max(1, Math.min(4, Number(args?.n) || 2))
          const prompt: string = (args?.prompt || '').toString().trim()
          if (!prompt) throw new Error('prompt required')
          // Resolve target imageId → default to chosen_image_id
          let imageId: string | null = (args?.imageId || '').toString() || null
          if (!imageId) {
            // Fallback: latest 'chosen' image, else latest candidate
            const { data: chosen } = await supabase
              .from('images')
              .select('id')
              .eq('order_id', orderId)
              .eq('kind', 'chosen')
              .order('created_at', { ascending: false })
              .limit(1)
            imageId = chosen?.[0]?.id || null
            if (!imageId) {
              const { data: anyImg } = await supabase
                .from('images')
                .select('id')
                .eq('order_id', orderId)
                .order('created_at', { ascending: false })
                .limit(1)
              imageId = anyImg?.[0]?.id || null
            }
          }
          if (!imageId) throw new Error('no_selected_concept')
          const { data: imgRow, error: imgErr } = await supabase.from('images').select('id,url').eq('order_id', orderId).eq('id', imageId).single()
          if (imgErr || !imgRow) throw new Error('image_not_found')
          // Resolve a usable URL (signed if in supabase://)
          let inputUrl = imgRow.url
          try { inputUrl = await signedUrlOrDirect(imgRow.url) } catch {}
          const editor = getEditProvider(process.env.EDIT_PROVIDER)
          const { imageUrls, description } = await editor.editImage({ imageUrl: inputUrl, prompt, n, format: (args?.format === 'png' ? 'png' : 'jpeg') })
          if (!imageUrls || !imageUrls.length) throw new Error('edit_returned_no_images')
          // Mirror edited results to storage
          const bucket2 = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
          try { await ensureStorageBucket(bucket2) } catch {}
          const mirrored2: { url: string }[] = []
          for (const u of (imageUrls || []).slice(0,n)) {
            try {
              const res = await fetch(u); if (!res.ok) throw new Error(`fetch ${res.status}`)
              const ab = await res.arrayBuffer(); const b = Buffer.from(ab)
              const ct = (res.headers.get('content-type') || 'image/jpeg').toLowerCase()
              const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
              const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
              const path = `edited/${orderId}/${name}`
              const up = await supabase.storage.from(bucket2).upload(path, b, { upsert: true, contentType: ct })
              if (up.error) throw up.error
              mirrored2.push({ url: `supabase://${bucket2}/${path}` })
            } catch { mirrored2.push({ url: u }) }
          }
          const rows = mirrored2.map((it) => ({ order_id: orderId, kind: 'candidate', url: it.url, meta_json: { parent_image_id: imgRow.id, edit_prompt: prompt, provider: 'nano-banana', description: description || null } }))
          const { data: inserted, error } = await supabase.from('images').insert(rows).select('id,url')
          if (error) throw error
          await supabase.from('orders').update({ status: 'await_image_pick' }).eq('id', orderId)
          await supabase.from('order_events').insert({ order_id: orderId, phase: 'visualizing', message: `Edited concept`, meta_json: { parent_image_id: imgRow.id, n } })
          const images = [] as any[]
          for (const r of inserted || []) {
            const canonical = normalizeSupabaseUrl(r.url) || r.url
            const signed = await signedUrlWithInfo(canonical)
            images.push({
              id: r.id,
              url: signed.url,
              storage_url: canonical,
              expires_at: signed.expiresAt ?? null,
            })
          }
          await supabase
            .from('chat_messages')
            .insert({ order_id: orderId, role: 'assistant', type: 'card.images', content_json: { prompt, images, n } })
          // Brief helper text
          const t = 'Variants ready — pick one to materialize or edit again.'
          await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: t } })
          send({ role: 'assistant', type: 'text', content: { text: t } })
          return { images }
        }

        async function adapter_viewer_focus(args: any) {
          const kind = args?.kind
          const url = args?.url
          if (!kind || !url) return { ok: false }
          const canonical = normalizeSupabaseUrl(url) || url
          const signed = await signedUrlWithInfo(canonical)
          send({
            role: 'assistant',
            type: 'viewer.focus',
            content: { kind, url: signed.url, storage_url: canonical, expires_at: signed.expiresAt ?? null },
          })
          return { ok: true }
        }

        async function adapter_fabricate(_args: any) {
          const transition = await requestFabrication(supabase, orderId, {
            actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
            idempotencyKey: `chat-fabricate:${orderId}`,
            eventMessage: 'Assistant requested fabrication',
            patch: { worker_id: null, locked_at: null, meta_json: { cancel_requested: false } },
          })
          if (transition.changed) {
            try {
              await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: 'On it — stabilizing the mesh for a print-ready quote.' } })
            } catch {}
            send({ role: 'assistant', type: 'text', content: { text: 'On it — stabilizing the mesh for a print-ready quote.' } })
          }
          return { ok: true, status: transition.newStatus, reused: transition.reused }
        }

        async function adapter_slice_and_quote(args: any) {
          // Require a repaired STL, either from args or latest asset
          let stlUrl: string | null = (args?.stlUrl as string) || null
          if (!stlUrl) {
            try {
              const { data: rep } = await supabase
                .from('assets')
                .select('url')
                .eq('order_id', orderId)
                .eq('kind', 'repaired_stl')
                .order('created_at', { ascending: false })
                .limit(1)
              stlUrl = rep?.[0]?.url || null
            } catch {}
          }
          if (!stlUrl) {
            return await adapter_fabricate(args)
          }
          const job = await requestSliceJob(supabase, orderId, {
            actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
            requestedBy: auth.user?.id ?? null,
            source: 'chat',
            eventMessage: 'Slice requested with STL',
          })
          try {
            await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: 'Slicing the provided STL with the Bambu profile.' } })
          } catch {}
          send({ role: 'assistant', type: 'text', content: { text: 'Slicing the provided STL with the Bambu profile.' } })
          return { ok: true, stlUrl, jobId: job.jobId, reused: job.reused }
        }

        async function adapter_repair_and_validate(_args: any) {
          const { data: existing } = await supabase
            .from('assets')
            .select('id,url,created_at')
            .eq('order_id', orderId)
            .eq('kind', 'repaired_stl')
            .order('created_at', { ascending: false })
            .limit(1)

          if (existing && existing.length) {
            const row = existing[0]
            const canonical = normalizeSupabaseUrl(row.url) || row.url
            const signed = await signedUrlWithInfo(canonical)
            const msg = 'Latest repaired STL is ready — focusing the viewer.'
            try {
              await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: msg } })
              await supabase
                .from('chat_messages')
                .insert({
                  order_id: orderId,
                  role: 'assistant',
                  type: 'viewer.focus',
                  content_json: {
                    kind: 'stl',
                    url: signed.url,
                    storage_url: canonical,
                    expires_at: signed.expiresAt ?? null,
                    asset_id: row.id,
                    asset_kind: 'repaired_stl',
                  },
                })
            } catch {}
            send({ role: 'assistant', type: 'text', content: { text: msg } })
            send({
              role: 'assistant',
              type: 'viewer.focus',
              content: { kind: 'stl', url: signed.url, storage_url: canonical, expires_at: signed.expiresAt ?? null },
            })
            return { ok: true, stlUrl: signed.url, status: 'ready' }
          }

          const { data: rawAsset } = await supabase
            .from('assets')
            .select('id,kind')
            .eq('order_id', orderId)
            .in('kind', ['raw_glb', 'raw_obj', 'raw_stl'])
            .order('created_at', { ascending: false })
            .limit(1)
          if (!rawAsset || !rawAsset.length) {
            throw new Error('no_mesh_available')
          }

          const transition = await requestFabrication(supabase, orderId, {
            actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
            idempotencyKey: `chat-repair:${orderId}`,
            eventMessage: 'Repair requested via chat tool',
            eventMeta: { requested_by: 'chat', intent: 'repair' },
            patch: { worker_id: null, locked_at: null, meta_json: { cancel_requested: false } },
          })
          try {
            await supabase.rpc('merge_order_facts', { p_order_id: orderId, p_facts: { fabrication_intent: 'repair' } })
          } catch {}
          const txt = 'Stabilizing the mesh — I’ll drop the repaired STL here once it passes checks.'
          try { await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: txt } }) } catch {}
          send({ role: 'assistant', type: 'text', content: { text: txt } })
          return { ok: true, status: transition.newStatus, reused: transition.reused }
        }

        async function adapter_dispatch_print(args: any) {
          if (!(auth.isAdmin || auth.isOperator)) {
            throw new Error('forbidden')
          }
          let threeMfUrl: string | null = typeof args?.threeMfUrl === 'string' && args.threeMfUrl ? args.threeMfUrl : null
          if (!threeMfUrl) {
            const { data: three } = await supabase
              .from('assets')
              .select('id,url,created_at')
              .eq('order_id', orderId)
              .eq('kind', 'three_mf')
              .order('created_at', { ascending: false })
              .limit(1)
            threeMfUrl = three?.[0]?.url || null
          }
          if (!threeMfUrl) {
            throw new Error('three_mf_missing')
          }
          const canonicalThreeMf = normalizeSupabaseUrl(threeMfUrl) || threeMfUrl
          let signed = canonicalThreeMf
          try { signed = (await signedUrlWithInfo(canonicalThreeMf)).url } catch {}
          const link = buildBambuConnectLink(signed)

          const transition = await requestDispatch(supabase, orderId, {
            actor: 'operator',
            idempotencyKey: `chat-dispatch:${canonicalThreeMf}`,
            eventMessage: 'Dispatch link issued (chat)',
            eventMeta: { link },
            patch: { worker_id: null, locked_at: null },
          })

          try { await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: `Open to print: ${link}` } }) } catch {}
          send({ role: 'assistant', type: 'text', content: { text: `Open to print: ${link}` } })
          return { ok: true, link, status: transition.newStatus, reused: transition.reused }
        }

        async function executeTool(name: string, args: any) {
          if (name === 'visualize_generate') return await adapter_visualize_generate(args)
          if (name === 'attachment_promote_concept') return await adapter_attachment_promote(args)
          if (name === 'attachment_edit') return await adapter_attachment_edit(args)
          if (name === 'attachment_generate_angles') return await adapter_attachment_generate_angles(args)
          if (name === 'materialize_i23d') return await adapter_materialize_i23d(args)
          if (name === 'visualize_select') return await adapter_materialize_i23d(args)
          if (name === 'concept_edit') return await adapter_concept_edit(args)
          if (name === 'viewer_focus') return await adapter_viewer_focus(args)
          if (name === 'fabricate_mesh') return await adapter_fabricate(args)
          if (name === 'slice_and_quote') return await adapter_slice_and_quote(args)
          if (name === 'repair_and_validate') return await adapter_repair_and_validate(args)
          if (name === 'dispatch_print') return await adapter_dispatch_print(args)
          if (name === 'context_refresh') {
            const snap = await buildContextSnapshot(orderId)
            return { snapshot: snap }
          }
          if (name === 'get_active_concept') {
            // Answer from facts or provenance mapping to last candidates
            const { data: order } = await supabase
              .from('orders')
              .select('id,chosen_image_id,meta_json')
              .eq('id', orderId)
              .single()
            let chosenId = order?.chosen_image_id as string | null
            if (!chosenId) {
              const { data: rep } = await supabase
                .from('assets')
                .select('meta_json')
                .eq('order_id', orderId)
                .eq('kind','repaired_stl')
                .order('created_at',{ascending:false})
                .limit(1)
              const ids = (rep?.[0]?.meta_json?.source_image_ids as string[]) || []
              chosenId = ids[0] || null
            }
            let index: number | null = null
            if (chosenId) {
              const { data: lastCard } = await supabase
                .from('chat_messages')
                .select('content_json')
                .eq('order_id', orderId)
                .eq('type','card.images')
                .order('created_at',{ascending:false})
                .limit(1)
              const arr = (lastCard?.[0]?.content_json?.images || []) as any[]
              const hit = arr.find((x:any)=>x.id===chosenId)
              index = hit?.index || null
            }
            return { id: chosenId || null, index }
          }
          if (name === 'compare_mesh_to_concepts') {
            // Prefer provenance; otherwise attempt a best-effort mapping to latest card order
            const { data: rep } = await supabase
              .from('assets')
              .select('meta_json')
              .eq('order_id', orderId)
              .eq('kind','repaired_stl')
              .order('created_at',{ascending:false})
              .limit(1)
            const ids = (rep?.[0]?.meta_json?.source_image_ids as string[]) || []
            let id = ids[0] || null
            let index: number | null = null
            if (id) {
              const { data: lastCard } = await supabase
                .from('chat_messages')
                .select('content_json')
                .eq('order_id', orderId)
                .eq('type','card.images')
                .order('created_at',{ascending:false})
                .limit(1)
              const arr = (lastCard?.[0]?.content_json?.images || []) as any[]
              const hit = arr.find((x:any)=>x.id===id)
              index = hit?.index || null
            }
            // If no provenance, return null; hashing fallback could be added later
            return { id, index, method: id ? 'provenance' : 'unknown' }
          }
          if (name === 'list_angles_for_active_concept') {
            // Find selected concept id
            const { data: order } = await supabase
              .from('orders')
              .select('chosen_image_id')
              .eq('id', orderId)
              .single()
            let parentId = order?.chosen_image_id as string | null
            if (!parentId) {
              const { data: rep } = await supabase
                .from('assets')
                .select('meta_json')
                .eq('order_id', orderId)
                .eq('kind','repaired_stl')
                .order('created_at',{ascending:false})
                .limit(1)
              const ids = (rep?.[0]?.meta_json?.source_image_ids as string[]) || []
              parentId = ids[0] || null
            }
            if (!parentId) return { parent_image_id: null, labels: [], image_ids: [], images: [] }
            const { data: rows } = await supabase
              .from('images')
              .select('id,url,meta_json')
              .eq('order_id', orderId)
              .contains('meta_json', { group: 'angles', parent_image_id: parentId })
              .order('created_at',{ascending:true})
            const labels: string[] = []
            const image_ids: string[] = []
            const images: any[] = []
            for (const r of rows || []) {
              const canonical = normalizeSupabaseUrl(r.url) || r.url
              const signed = await signedUrlWithInfo(canonical)
              labels.push((r as any)?.meta_json?.angle || 'angle')
              image_ids.push((r as any).id)
              images.push({
                id: (r as any).id,
                url: signed.url,
                storage_url: canonical,
                expires_at: signed.expiresAt ?? null,
              })
            }
            // Map to candidate index
            let index: number | null = null
            try {
              const { data: lastCard } = await supabase
                .from('chat_messages')
                .select('content_json')
                .eq('order_id', orderId)
                .eq('type','card.images')
                .order('created_at',{ascending:false})
                .limit(1)
              const arr = (lastCard?.[0]?.content_json?.images || []) as any[]
              const hit = arr.find((x:any)=>x.id===parentId)
              index = hit?.index || null
            } catch {}
            return { parent_image_id: parentId, parent_index: index, labels, image_ids, images }
          }
          // Not implemented here: repair/slice/dispatch — handled by worker pipeline
          return { ok: true }
        }

        try {
          let history = await buildHistory()
          let loop = 0
          while (loop < 3) {
            loop++
            let r1: any
            try {
              r1 = await callLLM(history)
            } catch (e: any) {
              const err = e?.message || 'llm_error'
              if (err === 'llm_timeout' || err === 'llm_unavailable' || err === 'llm_error') {
                // Do not auto-generate concepts; keep context intact. Provide a facts-mode helper line.
                try { await supabase.from('order_events').insert({ order_id: orderId, phase: 'llm_failed', message: err }) } catch {}
                try {
                  const snap = await buildContextSnapshot(orderId)
                  let line = ''
                  if (snap?.geometry?.stl_url) {
                    line = 'Your model is ready. I can size it or slice a quote.'
                  } else if (Array.isArray(snap?.images) && snap.images.length) {
                    const n = snap.images.length
                    line = `I see ${n} concept image${n>1?'s':''}. Pick one to materialize, ask for angles, or say which to use (e.g., “use C2”).`
                  } else {
                    line = 'Tell me what to make and I will generate concepts.'
                  }
                  send({ role: 'assistant', type: 'text', content: { text: line } })
                  await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: line } })
                } catch {}
                break
              }
              throw e
            }
            const choice = r1.choices?.[0]
            const msg = choice?.message
            const toolCalls = msg?.tool_calls || []
            const firstTextRaw = (msg?.content || '').toString().trim()
            // When there are no tool calls, forward the full assistant text.
            // Do not truncate; the UI can render long answers with scroll.
            if (!toolCalls.length && firstTextRaw) {
              send({ role: 'assistant', type: 'text', content: { text: firstTextRaw } })
              await persistAssistantText(firstTextRaw)
            }
            if (!toolCalls.length) break

            // Include the assistant message with tool_calls in history
            history.push({ role: 'assistant', content: toolCalls.length ? '' : firstTextRaw || '', tool_calls: toolCalls as any })

            // Execute tools sequentially and append tool results
            // Execute at most ONE tool per assistant turn to prevent duplicate cards.
            let ranAnyTool = false
            let wantFollowup = false
            // Prefer visualize_generate over other calls if present.
            const prioritized = toolCalls.find((t: any) => (t.function?.name || '') === 'visualize_generate') || toolCalls[0]
            if (prioritized) {
              const tc = prioritized
              const name = tc.function?.name || ''
              let args: any = {}
              try { args = JSON.parse(tc.function?.arguments || '{}') } catch {}
              try {
                // Guard visualize_generate when context already exists and the user did not express create intent
                if (name === 'visualize_generate') {
                  let blocked = false
                  try {
                    const snap = await buildContextSnapshot(orderId)
                    const hasContext = !!(snap?.geometry?.stl_url || snap?.selected_image_id || (Array.isArray(snap?.images) && snap.images.length))
                    const intentText = (message || '').toString().toLowerCase()
                    const normalized = intentText.replace(/[^a-z0-9\s]/g, ' ')
                    const baseIntent = /\b(build|make|create|generate|design|visualize|start over|start-over|new|another|fresh|replace|swap|switch|change|redo|restart|try|instead|reset)\b/.test(intentText) || /\b(new concepts?|new idea)\b/.test(intentText) || /\b(let['`]?s\s+(do|try|build|make|create))\b/.test(intentText) || /\b(can\s+we\s+(do|try|make|build|create))\b/.test(intentText)
                    const yesIntent = /\b(yes|yeah|yep|yup|y|sure|ok|okay|alright|fine|do it|go for it|go ahead|please|sounds good|let s go|lets go|yus|yas|yess|yass|absolutely|affirmative|of course|sure thing)\b/.test(normalized)

                    let pendingResetPrompt = false
                    try {
                      for (let i = history.length - 1; i >= 0; i--) {
                        const h = history[i]
                        if (!h) continue
                        if (h.role === 'assistant' && typeof h.content === 'string' && h.content) {
                          if (/(start over|replace the current|new concept|generate fresh|I can swap|Want me to replace)/i.test(h.content)) {
                            pendingResetPrompt = true
                            break
                          }
                        }
                        if (h.role === 'user') break
                      }
                    } catch {}

                    const blockedRecently = history.slice(-5).some((h: any) => h?.role === 'tool' && typeof h?.content === 'string' && h.content.includes('"blocked":"context_present"'))

                    const createIntent = baseIntent || (yesIntent && (pendingResetPrompt || blockedRecently))
                    if (hasContext && !createIntent) blocked = true
                  } catch {}
                  if (blocked) {
                    const note = 'We already have a design underway. I can size it, slice a quote, or tweak it. Say “start over” to brainstorm new concepts.'
                    send({ role: 'assistant', type: 'text', content: { text: note } })
                    await persistAssistantText(note)
                    const result = { ok: false, blocked: 'context_present' }
                    await supabase.from('chat_messages').insert({ order_id: orderId, role: 'tool', type: 'tool.result', content_json: { name, result } })
                    history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
                    ranAnyTool = true
                    wantFollowup = true
                  } else {
                    const result = await executeTool(name, args)
                    await supabase.from('chat_messages').insert({ order_id: orderId, role: 'tool', type: 'tool.result', content_json: { name, result } })
                    history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
                    ranAnyTool = true
                    if (['get_active_concept','compare_mesh_to_concepts','context_refresh','viewer_focus'].includes(name)) {
                      wantFollowup = true
                    }
                  }
                } else if (name === 'materialize_i23d' || name === 'visualize_select') {
                  const ids = Array.isArray(args?.imageIds) ? (args.imageIds as any[]).filter((id) => typeof id === 'string' && id).map(String) : []
                  if (!ids.length) {
                    const hint = 'Pick a concept tile and tap Materialize, or say e.g. “use C2”.'
                    send({ role: 'assistant', type: 'text', content: { text: hint } })
                    await persistAssistantText(hint)
                    const result = { ok: false, blocked: 'user_confirmation_required' }
                    await supabase.from('chat_messages').insert({ order_id: orderId, role: 'tool', type: 'tool.result', content_json: { name, result } })
                    history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
                    ranAnyTool = true
                    wantFollowup = true
                    continue
                  }
                  const result = await executeTool(name, { imageIds: ids })
                  await supabase.from('chat_messages').insert({ order_id: orderId, role: 'tool', type: 'tool.result', content_json: { name, result } })
                  history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
                  ranAnyTool = true
                } else {
                  const result = await executeTool(name, args)
                  await supabase.from('chat_messages').insert({ order_id: orderId, role: 'tool', type: 'tool.result', content_json: { name, result } })
                  // Provide result back to LLM
                  history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
                  ranAnyTool = true
                  // For query-type tools (no UI cards), allow a follow-up assistant turn
                  if (['get_active_concept','compare_mesh_to_concepts','context_refresh','viewer_focus'].includes(name)) {
                    wantFollowup = true
                  }
                }
              } catch (e: any) {
                const err = e?.message || 'tool_error'
                // Inform UI and persist warning
                send({ role: 'assistant', type: 'text', content: { text: `Tool ${name} failed: ${err}` } })
                await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'warning', content_json: { text: `Tool ${name} failed: ${err}` } })
                // Also respond to the tool_call in the LLM history to satisfy the API constraint
                try { history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: err }) }) } catch {}
                ranAnyTool = true
              }
            }
            // For tools that render cards or trigger jobs, stop; for pure queries, let the LLM respond.
            if (ranAnyTool && !wantFollowup) break
            if (ranAnyTool && wantFollowup) continue
          }
        } catch (e: any) {
          send({ role: 'assistant', type: 'warning', content: { text: e?.message || 'chat error' } })
        } finally {
          controller.close()
        }
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
