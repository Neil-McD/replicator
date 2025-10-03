import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const orderId = params.id
    const body = await req.json().catch(() => ({})) as { target_max_dim_mm?: number; upright?: boolean; rotation_euler_deg?: [number,number,number] }
    // Clamp target to a safe maximum (default 230 mm) so exported/sliced models
    // never exceed printer-friendly limits even if the client sends a larger value.
    const rawTarget = Number(body?.target_max_dim_mm)
    const maxTarget = Math.max(20, Number(process.env.MAX_TARGET_DIM_MM || 230))
    const target = Number.isFinite(rawTarget) ? Math.min(rawTarget, maxTarget) : NaN
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    if (!isFinite(target) && !body?.upright && !body?.rotation_euler_deg) return NextResponse.json({ error: 'no transform provided' }, { status: 400 })
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
    // Clear cancel flag on explicit transform intent
    try {
      const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
      const prev = (row?.meta_json as any) || {}
      const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
      await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
    } catch {}
    // Store transform as an asset so worker can read the latest one
    const meta: any = {}
    if (isFinite(target) && target > 0) meta.target_max_dim_mm = target
    if (body?.upright) meta.upright = true
    if (Array.isArray(body?.rotation_euler_deg) && body.rotation_euler_deg.length === 3) meta.rotation_euler_deg = body.rotation_euler_deg

    if (meta.target_max_dim_mm == null) {
      try {
        const { data: priorTransforms } = await supabase
          .from('assets')
          .select('meta_json')
          .eq('order_id', orderId)
          .eq('kind', 'transform')
          .order('created_at', { ascending: false })
          .limit(1)
        const priorMeta = Array.isArray(priorTransforms) && priorTransforms.length > 0 ? (priorTransforms[0]?.meta_json || {}) : {}
        const priorTarget = Number(priorMeta?.target_max_dim_mm ?? priorMeta?.target_max_dim ?? priorMeta?.target)
        if (Number.isFinite(priorTarget) && priorTarget > 0) {
          meta.target_max_dim_mm = priorTarget
        }
      } catch {}
    }
    await supabase.from('assets').insert({
      order_id: orderId,
      kind: 'transform',
      url: '',
      meta_json: meta,
    })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
