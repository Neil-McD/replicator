import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect, ensureStorageBucket, signedUrlWithInfo, normalizeSupabaseUrl } from '@/lib/supabaseAdmin'
import { getEditProvider } from '@/lib/providers/edit'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { transitionOrder } from '@/lib/orderState'

export const runtime = 'nodejs'

// POST /api/edit
// Body: { orderId: string, imageId?: string, prompt: string, n?: number, format?: 'jpeg'|'png' }
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
    const body = await req.json().catch(() => ({})) as any
    const orderId: string = body.orderId
    const prompt: string = (body.prompt || '').toString()
    // Hard cap edit variants to avoid flooding the chat with many images.
    const MAX_EDIT = Math.max(1, Math.min(4, Number(process.env.MAX_EDIT_VARIANTS || 2)))
    const n: number = Math.max(1, Math.min(MAX_EDIT, Number(body.n) || MAX_EDIT))
    const format = body.format === 'png' ? 'png' : 'jpeg'
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    if (!prompt) return NextResponse.json({ error: 'prompt required' }, { status: 400 })
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    // Clear cancel flag to resume after a refresh cancel
    try {
      const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
      const prev = (row?.meta_json as any) || {}
      const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
      await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
    } catch {}
    // Resolve target image (use explicit imageId else chosen_image_id)
    let imageId: string | null = (body.imageId || '').toString() || null
    if (!imageId) {
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
    if (!imageId) return NextResponse.json({ error: 'no_selected_concept' }, { status: 400 })
    const { data: imgRow, error: imgErr } = await supabase.from('images').select('id,url').eq('order_id', orderId).eq('id', imageId).single()
    if (imgErr || !imgRow) return NextResponse.json({ error: 'image_not_found' }, { status: 404 })
    let inputUrl = imgRow.url
    try { inputUrl = await signedUrlOrDirect(imgRow.url) } catch {}
    await transitionOrder(supabase, {
      orderId,
      to: 'visualizing',
      authority: 'visualize',
      expectedFrom: ['new', 'await_image_pick', 'generate_failed', 'repair_failed', 'slice_failed', 'needs_review'],
      idempotencyKey: `edit:start:${orderId}:${imageId}:${prompt}:${n}`,
      meta: { parent_image_id: imgRow.id, n },
    })
    const editor = getEditProvider(process.env.EDIT_PROVIDER)
    const { imageUrls, description } = await editor.editImage({ imageUrl: inputUrl, prompt, n, format })
    if (!imageUrls || !imageUrls.length) return NextResponse.json({ error: 'edit_returned_no_images' }, { status: 500 })
    // Clamp to at most n (and MAX_EDIT) even if the provider returns more.
    const limited = imageUrls.slice(0, n)
    // Mirror to storage to avoid timeouts later when materializing
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
    await ensureStorageBucket(bucket)
    const mirrored: { url: string }[] = []
    for (const u of limited) {
      try {
        const res = await fetch(u)
        if (!res.ok) throw new Error(`fetch ${res.status}`)
        const ab = await res.arrayBuffer()
        const b = Buffer.from(ab)
        const ct = (res.headers.get('content-type') || 'image/jpeg').toLowerCase()
        const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
        const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const path = `edited/${orderId}/${name}`
        const up = await supabase.storage.from(bucket).upload(path, b, { upsert: true, contentType: ct })
        if (up.error) throw up.error
        const supaUrl = `supabase://${bucket}/${path}`
        mirrored.push({ url: supaUrl })
      } catch {
        mirrored.push({ url: u })
      }
    }
    const rows = mirrored.map((it) => ({ order_id: orderId, kind: 'candidate', url: it.url, meta_json: { parent_image_id: imgRow.id, edit_prompt: prompt, provider: 'nano-banana', description: description || null } }))
    const { data: inserted, error } = await supabase.from('images').insert(rows).select('id,url')
    if (error) throw error
    await transitionOrder(supabase, {
      orderId,
      to: 'await_image_pick',
      authority: 'visualize',
      expectedFrom: 'visualizing',
      idempotencyKey: `edit:complete:${orderId}:${(inserted || []).map((row: any) => row.id).join(',')}`,
      meta: { image_count: inserted?.length || 0 },
    })
    await supabase.from('order_events').insert({ order_id: orderId, phase: 'visualizing', message: 'Edited concept', meta_json: { parent_image_id: imgRow.id, n } })
    const imagesRaw = (inserted || []).slice(0, n)
    const signedMap = new Map<string, { url: string; storage_url: string; expires_at: number | null }>()
    for (const row of imagesRaw) {
      const canonical = normalizeSupabaseUrl(row.url) || row.url
      const signed = await signedUrlWithInfo(canonical)
      signedMap.set(row.id, { url: signed.url, storage_url: canonical, expires_at: signed.expiresAt ?? null })
    }
    const images = imagesRaw.map((r: any) => {
      const signed = signedMap.get(r.id)
      return {
        id: r.id,
        url: signed?.url || r.url,
        storage_url: signed?.storage_url || r.url,
        expires_at: signed?.expires_at ?? null,
      }
    })
    await supabase
      .from('chat_messages')
      .insert({ order_id: orderId, role: 'assistant', type: 'card.images', content_json: { prompt, images, n } })
    return NextResponse.json({ images })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
