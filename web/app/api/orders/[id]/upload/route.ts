import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { lifecycle } from '@/lib/lifecycle'

export const runtime = 'nodejs'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const orderId = params.id
  try {
    console.log('[api/orders/:id/upload POST] id=', orderId)
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
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    const form = await req.formData()
    const file = form.get('file') as File | null
    if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 })

    const now = Date.now()
    const name = (file as any).name || 'upload'
    const ext = name.split('.').pop()?.toLowerCase() || 'bin'
    const arrayBuf = await file.arrayBuffer()
    const path = `uploads/${orderId}/${now}-${name}`
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'

    const { error: upErr } = await supabase.storage.from(bucket).upload(path, new Uint8Array(arrayBuf), {
      upsert: true,
      contentType: file.type || 'application/octet-stream',
    })
    if (upErr) throw upErr

    const url = `supabase://${bucket}/${path}`
    let kind = 'upload_bin'
    if (['stl'].includes(ext)) kind = 'upload_stl'
    else if (['obj'].includes(ext)) kind = 'upload_obj'
    else if (['glb', 'gltf'].includes(ext)) kind = 'upload_glb'
    else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) kind = 'upload_image'

    await supabase.from('assets').insert({
      order_id: orderId,
      kind,
      url,
      meta_json: {
        name,
        size: file.size,
        type: file.type,
        origin: 'user_upload',
      },
    })
    console.log('[api/orders/:id/upload POST] saved asset kind=', kind, 'path=', path)
    // Nudge the pipeline without resetting customer-visible lifecycle state.
    try {
      if (kind === 'upload_image') {
        await lifecycle.requestVisualization({
          supabase,
          orderId,
          actor: auth.user?.id || 'user',
          idempotencyKey: `order:${orderId}:visualize:upload:${path}`,
          metadata: { kind, path },
        })
      } else if (['upload_stl', 'upload_obj', 'upload_glb'].includes(kind)) {
        await lifecycle.requestStabilization({
          supabase,
          orderId,
          actor: auth.user?.id || 'user',
          idempotencyKey: `order:${orderId}:stabilize:upload:${path}`,
          metadata: { kind, path },
        })
      }
      await supabase.from('order_events').insert({ order_id: orderId, phase: 'upload', message: `uploaded ${kind}` })
    } catch {}
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('[api/orders/:id/upload POST] error:', e?.message)
    return NextResponse.json({ error: e.message || 'failed' }, { status: 500 })
  }
}
