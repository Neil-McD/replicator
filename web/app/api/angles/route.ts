import { NextResponse } from 'next/server'
import { createAdminClient, ensureStorageBucket, signedUrlOrDirect, signedUrlWithInfo, normalizeSupabaseUrl } from '@/lib/supabaseAdmin'
import { getEditProvider } from '@/lib/providers/edit'
import { mirrorRemoteImageToStorage } from '@/lib/storage'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'

// POST /api/angles
// Body: { orderId: string, imageId: string, angles?: string[] }
// Generates additional viewpoints for a selected concept image.
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
    const imageId: string = body.imageId
    const anglesInput: string[] = Array.isArray(body.angles) ? body.angles : []
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    if (!imageId) return NextResponse.json({ error: 'imageId required' }, { status: 400 })
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

    const { data: imgRow, error: imgErr } = await supabase
      .from('images')
      .select('id,url')
      .eq('order_id', orderId)
      .eq('id', imageId)
      .single()
    if (imgErr || !imgRow) return NextResponse.json({ error: 'image_not_found' }, { status: 404 })

    // Resolve a fetchable URL
    let baseUrl = imgRow.url
    try { baseUrl = await signedUrlOrDirect(imgRow.url) } catch {}

    // Determine which angles to generate
    const DEFAULTS = ['top', 'bottom', 'opposite'] as const
    const requested = (anglesInput.length ? anglesInput : DEFAULTS).filter((k) => ['top','bottom','opposite'].includes(String(k))) as ('top'|'bottom'|'opposite')[]
    if (!requested.length) return NextResponse.json({ error: 'no_angles_requested' }, { status: 400 })

    // Simple per-parent cooldown to avoid spamming provider on rapid clicks
    const cooldownS = Math.max(1, Number(process.env.ANGLES_COOLDOWN_S || 8))
    try {
      const since = new Date(Date.now() - cooldownS * 1000).toISOString()
      const { data: recent } = await supabase
        .from('images')
        .select('id,url,meta_json,created_at')
        .eq('order_id', orderId)
        .contains('meta_json', { parent_image_id: imageId, group: 'angles' })
        .gte('created_at', since)
        .order('created_at', { ascending: false })
      if (Array.isArray(recent) && recent.length >= 3) {
        const take = recent.slice(0, 3)
        const images = [] as any[]
        for (const r of take) {
          const canonical = normalizeSupabaseUrl(r.url) || r.url
          const signed = await signedUrlWithInfo(canonical)
          images.push({
            id: r.id,
            url: signed.url,
            storage_url: canonical,
            expires_at: signed.expiresAt ?? null,
            angle: (r as any)?.meta_json?.angle || 'angle',
          })
        }
        return NextResponse.json({ images })
      }
    } catch {}

    // Prompts per angle
    const PROMPTS: Record<'top'|'bottom'|'opposite', string> = {
      top: 'same object and style; change only the camera to a straight top‑down view; keep object centered; single object; neutral studio background; no new props; no text.',
      bottom: 'same object and style; change only the camera to a low angle that clearly shows the underside/bottom; slight tilt to reveal the bottom; single object; neutral studio background; no new props; no text.',
      opposite: 'same object and style; change only the camera to the opposite side/back of the current view (rear three‑quarter); single object; centered; neutral studio background; no new props; no text.',
    }

    const t0 = Date.now()
    const editor = getEditProvider(process.env.EDIT_PROVIDER)
    // Parallelize generation across requested angles
    const tasks = requested.map(async (a) => {
      try {
        const { imageUrls } = await editor.editImage({ imageUrl: baseUrl, prompt: PROMPTS[a], n: 1, format: 'jpeg' })
        const u = imageUrls?.[0]
        return u ? { angle: a, url: u } : null
      } catch {
        return null
      }
    })
    const produced = (await Promise.all(tasks)).filter(Boolean) as { angle: string; url: string }[]
    if (!produced.length) return NextResponse.json({ error: 'angles_failed' }, { status: 500 })

    // Mirror to Storage for reliability
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
    try { await ensureStorageBucket(bucket) } catch {}
    const mirrored: { angle: string; url: string }[] = []
    for (const p of produced) {
      const m = await mirrorRemoteImageToStorage(supabase, p.url, { bucket, prefix: `angles/${orderId}` })
      mirrored.push({ angle: p.angle, url: m })
    }

    // Replace older angles for this parent (server-side dedupe)
    try {
      await supabase
        .from('images')
        .delete()
        .eq('order_id', orderId)
        .contains('meta_json', { parent_image_id: imageId, group: 'angles' })
    } catch {}

    const rows = mirrored.map((it) => ({ order_id: orderId, kind: 'candidate', url: it.url, meta_json: { parent_image_id: imageId, group: 'angles', angle: it.angle } }))
    const { data: inserted, error } = await supabase
      .from('images')
      .insert(rows)
      .select('id,url')
    if (error) throw error

    // Prepare card payload
    const images = [] as any[]
    for (let i = 0; i < (inserted || []).length; i++) {
      const r: any = inserted![i]
      const angleLabel = mirrored[i]?.angle || requested[i] || `angle_${i + 1}`
      const canonical = normalizeSupabaseUrl(r.url) || r.url
      const signed = await signedUrlWithInfo(canonical)
      images.push({
        id: r.id,
        url: signed.url,
        storage_url: canonical,
        expires_at: signed.expiresAt ?? null,
        angle: angleLabel,
      })
    }
    await supabase
      .from('chat_messages')
      .insert({ order_id: orderId, role: 'assistant', type: 'card.images', content_json: { group: 'angles', parent_image_id: imageId, images, n: images.length } })
    await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: 'More angles ready. You can materialize them all or pick one.' } })
    await supabase.from('orders').update({ status: 'await_image_pick' }).eq('id', orderId)
    try {
      await supabase.from('order_events').insert({ order_id: orderId, phase: 'visualizing', message: 'Angles generated', meta_json: { parent_image_id: imageId, n: images.length, duration_ms: Date.now() - t0 } })
    } catch {}

    return NextResponse.json({ images })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
