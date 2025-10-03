import { NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createAdminClient, signedUrlWithInfo } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { parseDataUrl } from '@/lib/storeUtils'

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? 'artifacts'
const PREVIEW_TTL_SECONDS = Math.max(60, Number(process.env.SIGNED_URL_TTL_S || 900))

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const orderId = params.id
  if (!orderId) {
    return NextResponse.json({ error: 'order_id_required' }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const dataUrl = typeof body?.data_url === 'string' ? body.data_url : null
  const assetId = typeof body?.asset_id === 'string' ? body.asset_id : null
  if (!dataUrl || dataUrl.length < 100) {
    return NextResponse.json({ error: 'preview_missing' }, { status: 400 })
  }
  if (!assetId) {
    return NextResponse.json({ error: 'asset_id_required' }, { status: 400 })
  }

  const parsed = parseDataUrl(dataUrl)
  if (!parsed) {
    return NextResponse.json({ error: 'preview_invalid' }, { status: 422 })
  }

  let auth
  try {
    auth = await requireAuthContext(req)
  } catch (error: any) {
    const status = Number(error?.statusCode) || 401
    return NextResponse.json({ error: 'not_authenticated' }, { status })
  }

  const supabase = createAdminClient()
  try {
    await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
  } catch (error: any) {
    const { status, body: errBody } = handleOrderAccessError(error)
    return NextResponse.json(errBody, { status })
  }

  const fileName = `previews/${orderId}/mesh-${randomUUID()}.${parsed.ext}`
  const storagePath = `${fileName}`
  const canonicalUrl = `supabase://${STORAGE_BUCKET}/${storagePath}`

  const upload = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, parsed.buffer, {
    contentType: parsed.mime,
    upsert: false,
  })
  if (upload.error) {
    // Treat duplicate uploads as success so we don't block on retry
    const duplicate = String(upload.error.message || '').toLowerCase().includes('duplicate')
    if (!duplicate) {
      return NextResponse.json({ error: upload.error.message || 'upload_failed' }, { status: 500 })
    }
  }

  try {
    await supabase.from('assets').insert({
      order_id: orderId,
      kind: 'geometry_preview_png',
      url: canonicalUrl,
      meta_json: { source_asset_id: assetId },
    })
  } catch (error: any) {
    // Non-fatal; continue so chat still sees preview
    console.warn('[geometry-preview] failed to insert asset', error?.message || error)
  }

  let signedUrl = canonicalUrl
  let expiresAt: number | null = null
  try {
    const signed = await signedUrlWithInfo(canonicalUrl, PREVIEW_TTL_SECONDS)
    signedUrl = signed.url
    expiresAt = signed.expiresAt ?? null
  } catch (error: any) {
    console.warn('[geometry-preview] failed to sign preview', error?.message || error)
  }

  try {
    await supabase.from('chat_messages').insert({
      order_id: orderId,
      role: 'assistant',
      type: 'card.mesh',
      content_json: {
        asset_id: assetId,
        preview_url: signedUrl,
        preview_storage_url: canonicalUrl,
        preview_expires_at: expiresAt,
      },
    })
  } catch (error: any) {
    console.warn('[geometry-preview] failed to insert chat message', error?.message || error)
  }

  return NextResponse.json({ ok: true, previewUrl: signedUrl, storageUrl: canonicalUrl, expiresAt })
}
