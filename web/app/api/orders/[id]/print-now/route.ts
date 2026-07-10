import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { idempotencyKeys, lifecycle } from '@/lib/lifecycle'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    // Operator gating: only admin/operator can dispatch prints (Phase-1)
    if (!(auth.isAdmin || auth.isOperator)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const body = await req.json().catch(() => ({})) as any
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id,status,payment_status')
      .eq('id', params.id)
      .single()
    if (orderError || !order) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const operatorOverride = Boolean(body?.operator_override)
    if (order.status !== 'paid' && order.status !== 'dispatching' && order.status !== 'dispatch_failed' && !operatorOverride) {
      return NextResponse.json({ error: 'payment_required', status: order.status }, { status: 409 })
    }
    if (operatorOverride && order.status !== 'paid') {
      await supabase.from('order_events').insert({
        order_id: params.id,
        phase: 'operator_override',
        message: 'Operator override allowed print dispatch before paid status',
        meta_json: { previous_status: order.status, payment_status: order.payment_status || null },
      })
    }
    const { data: asset } = await supabase.from('assets').select('*').eq('order_id', params.id).eq('kind', 'three_mf').order('created_at', { ascending: false }).limit(1).single()
    if (!asset) return NextResponse.json({ error: '3MF not found' }, { status: 404 })
    const signed = await signedUrlOrDirect(asset.url)
    const link = `bambu-connect://import-file?file=${encodeURIComponent(signed)}`
    await lifecycle.requestDispatch({
      supabase,
      orderId: params.id,
      actor: auth.user?.id || 'user',
      idempotencyKey: idempotencyKeys.dispatch(params.id, asset.sha256 || asset.id),
      metadata: { asset_id: asset.id, operator_override: operatorOverride },
    })
    return NextResponse.json({ link })
  } catch (e: any) {
    // Swallow detailed server logs; return minimal error
    return NextResponse.json({ error: e.message || 'failed' }, { status: 500 })
  }
}
