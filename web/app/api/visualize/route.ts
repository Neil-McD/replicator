import { NextResponse } from 'next/server'
import { createAdminClient, ensureStorageBucket, signedUrlOrDirect, signedUrlWithInfo, normalizeSupabaseUrl } from '@/lib/supabaseAdmin'
import { getT2IProvider } from '@/lib/providers/t2i'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { transitionOrder } from '@/lib/orderState'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    const body = (await req.json().catch(() => ({}))) as any
    const orderId = body.orderId || body.order_id
    const prompt: string = (body.prompt || '').toString()
    const n: number = Math.max(1, Math.min(6, Number(body.n) || 6))
    const style: string | undefined = body.style || undefined
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 })
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    // Clear cancel flag when starting a fresh visualization sequence
    try {
      const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
      const prev = (row?.meta_json as any) || {}
      const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
      await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
    } catch {}

    // Basic moderation guard (align with orders route)
    const BLOCKLIST = ['weapon','gun','knife','drone','illegal','ip','copyright','trademark','nazi','bomb']
    const flagged = prompt.toLowerCase()
    const needsReview = BLOCKLIST.some(w => flagged.includes(w))
    if (needsReview) {
      await supabase.from('order_events').insert({ order_id: orderId, phase: 'needs_review', message: 'Blocked by moderation guard (visualize)' })
      return NextResponse.json({ error: 'prompt_blocked' }, { status: 400 })
    }

    await transitionOrder(supabase, {
      orderId,
      to: 'visualizing',
      authority: 'visualize',
      expectedFrom: ['new', 'await_image_pick', 'generate_failed', 'repair_failed', 'slice_failed', 'needs_review'],
      idempotencyKey: `visualize:start:${orderId}:${prompt}:${style || 'none'}:${n}`,
      meta: { n, style: style || null },
    })

    // Generate N concepts via T2I provider (MVP default: 6)
    const provider = getT2IProvider(process.env.T2I_PROVIDER)
    const { imageUrls } = await provider.generateImages({ prompt, n, style })
    if (!imageUrls || imageUrls.length === 0) {
      return NextResponse.json({ error: 'no_images' }, { status: 500 })
    }
    // Mirror remote images into Storage to avoid future download timeouts
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
    await ensureStorageBucket(bucket)
    const uploaded: { id: string; url: string; signed: string; origin: 'mirrored'|'remote_unmirrored' }[] = []
    for (const u of imageUrls) {
      try {
        const res = await fetch(u)
        if (!res.ok) throw new Error(`fetch ${res.status}`)
        const ab = await res.arrayBuffer()
        const b = Buffer.from(ab)
        const ct = (res.headers.get('content-type') || 'image/jpeg').toLowerCase()
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
        const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const path = `generated/${orderId}/${name}`
        const up = await supabase.storage.from(bucket).upload(path, b, { upsert: true, contentType: ct })
        if (up.error) throw up.error
        const supaUrl = `supabase://${bucket}/${path}`
        const signed = await signedUrlOrDirect(supaUrl)
        uploaded.push({ id: '', url: supaUrl, signed, origin: 'mirrored' })
      } catch (e) {
        // Fallback: keep remote URL if mirroring fails
        uploaded.push({ id: '', url: u, signed: u, origin: 'remote_unmirrored' })
      }
    }
    const rows = uploaded.map((it) => ({ order_id: orderId, kind: 'candidate', url: it.url, meta_json: { prompt, style, origin: it.origin } }))
    const { data: inserted, error } = await supabase
      .from('images')
      .insert(rows)
      .select('id,url,created_at')
    if (error) throw error
    // Include stable indices in the card so future turns can map 1..N
    const indexed = (inserted||[]).map((r:any, i:number)=>({ id: r.id, url: r.url, index: i+1 }))
    // Sign URLs for card while preserving original storage path
    const signedMap = new Map<string, { url: string; storage_url: string; expires_at: number | null }>()
    for (const r of inserted || []) {
      const canonical = normalizeSupabaseUrl(r.url) || r.url
      const signed = await signedUrlWithInfo(canonical)
      signedMap.set(r.id, { url: signed.url, storage_url: canonical, expires_at: signed.expiresAt ?? null })
    }
    await supabase.from('chat_messages').insert({
      order_id: orderId,
      role: 'assistant',
      type: 'card.images',
      content_json: {
        prompt,
        style: style || null,
        images: indexed.map((it:any) => {
          const signed = signedMap.get(it.id)
          return {
            ...it,
            url: signed?.url || it.url,
            storage_url: signed?.storage_url || it.url,
            expires_at: signed?.expires_at ?? null,
          }
        }),
        n: indexed.length,
      },
    })
    await transitionOrder(supabase, {
      orderId,
      to: 'await_image_pick',
      authority: 'visualize',
      expectedFrom: 'visualizing',
      idempotencyKey: `visualize:complete:${orderId}:${(inserted || []).map((row: any) => row.id).join(',')}`,
      meta: { image_count: inserted?.length || 0 },
    })
    await supabase.from('order_events').insert({ order_id: orderId, phase: 'visualizing', message: `Generated ${inserted?.length || 0} candidates` })

    return NextResponse.json({ images: inserted || [], message: 'ok' })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
