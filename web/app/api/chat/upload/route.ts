import { NextResponse } from 'next/server'
import { createAdminClient, ensureStorageBucket, signedUrlWithInfo, normalizeSupabaseUrl } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { transitionOrder } from '@/lib/orderState'

export const runtime = 'nodejs'

// POST /api/chat/upload (multipart/form-data)
// Fields: orderId (string), file(s) (image/*)
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
    const form = await req.formData()
    const orderId = String(form.get('orderId') || '')
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    const files: File[] = []
    for (const [k, v] of form.entries()) {
      if (v instanceof File && (k === 'file' || k === 'files' || v.type.startsWith('image/'))) files.push(v)
    }
    if (!files.length) return NextResponse.json({ error: 'no_files' }, { status: 400 })

    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
    await ensureStorageBucket(bucket)

    // Upload images to Storage and record assets
    const { count: existingCount } = await supabase
      .from('assets')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', orderId)
      .eq('kind', 'upload_image')

    const uploaded: { assetId: string; assetUrl: string; contentType: string; meta: { name: string; size: number; label: string } }[] = []
    for (const f of files) {
      const label = `A${((existingCount || 0) + uploaded.length + 1).toString()}`
      const arrayBuf = await f.arrayBuffer()
      const b = Buffer.from(arrayBuf)
      const ct = (f.type || 'image/jpeg').toLowerCase()
      const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
      const path = `uploads/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const up = await supabase.storage.from(bucket).upload(path, b, { upsert: true, contentType: ct })
      if (up.error) throw up.error
      const supaUrl = `supabase://${bucket}/${path}`
      const { data: assetRow, error: assetError } = await supabase
        .from('assets')
        .insert({
          order_id: orderId,
          kind: 'upload_image',
          url: supaUrl,
          meta_json: {
            name: f.name,
            size: f.size,
            type: ct,
            pending: true,
            label,
            origin: 'user_upload',
          },
        })
        .select('id')
        .single()
      if (assetError) throw assetError
      uploaded.push({ assetId: assetRow!.id as string, assetUrl: supaUrl, contentType: ct, meta: { name: f.name, size: f.size, label } })
    }
    const signTtl = Math.max(60, Number(process.env.SIGNED_URL_TTL_S || 900))
    const attachments = [] as { asset_id: string; storage_url: string; url: string; expires_at?: number | null; content_type: string; name: string; size: number; label: string }[]
    for (const item of uploaded) {
      const canonical = normalizeSupabaseUrl(item.assetUrl) || item.assetUrl
      const signed = await signedUrlWithInfo(canonical, signTtl)
      attachments.push({
        asset_id: item.assetId,
        storage_url: canonical,
        url: signed.url,
        expires_at: signed.expiresAt ?? null,
        content_type: item.contentType,
        name: item.meta.name,
        size: item.meta.size,
        label: item.meta.label,
      })
    }

    if (attachments.length) {
      await transitionOrder(supabase, {
        orderId,
        to: 'visualizing',
        authority: 'visualize',
        expectedFrom: ['new', 'await_image_pick', 'generate_failed', 'repair_failed', 'slice_failed', 'needs_review'],
        idempotencyKey: `chat_upload:${orderId}:${attachments.map((item) => item.asset_id).join(',')}`,
        meta: { attachment_count: attachments.length },
      })
      await supabase.from('order_events').insert({
        order_id: orderId,
        phase: 'visualizing',
        message: `Uploaded ${attachments.length} image(s); awaiting instructions`,
      })
    }

    return NextResponse.json({ attachments })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
