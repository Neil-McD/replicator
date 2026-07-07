import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { hasSliceDerivedQuote, requireAssetKinds, transitionOrder } from '@/lib/orderState'

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
    const { data: order, error: orderErr } = await supabase.from('orders').select('id,status,quote_json').eq('id', params.id).single()
    if (orderErr || !order) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (order.status !== 'paid') return NextResponse.json({ error: 'order_not_paid' }, { status: 409 })
    if (!hasSliceDerivedQuote(order.quote_json)) return NextResponse.json({ error: 'missing_quote' }, { status: 409 })
    const { data: payment } = await supabase
      .from('payments')
      .select('id,status,provider_ref')
      .eq('order_id', params.id)
      .eq('status', 'succeeded')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!payment) return NextResponse.json({ error: 'payment_not_found' }, { status: 409 })
    let artifacts
    try {
      artifacts = await requireAssetKinds(supabase, params.id, ['three_mf', 'gcode', 'slicedata'])
    } catch (gateErr: any) {
      return NextResponse.json({ error: 'missing_printable_artifacts', missing: gateErr?.missing || [] }, { status: 409 })
    }
    const asset = artifacts.three_mf
    const signed = await signedUrlOrDirect(asset.url)
    const link = `bambu-connect://import-file?file=${encodeURIComponent(signed)}`
    await transitionOrder(supabase, {
      orderId: params.id,
      to: 'dispatching',
      authority: 'operator',
      expectedFrom: 'paid',
      idempotencyKey: `operator:print-now:${params.id}:${asset.sha256 || asset.id}:${payment.id}`,
      meta: { three_mf_asset_id: asset.id, payment_id: payment.id, link },
    })
    await supabase.from('order_events').insert({ order_id: params.id, phase: 'dispatching', message: 'Dispatch link issued', meta_json: { link, payment_id: payment.id } })
    await supabase.from('chat_messages').insert({ order_id: params.id, role: 'assistant', type: 'text', content_json: { text: `Open to print: ${link}` } })
    return NextResponse.json({ link })
  } catch (e: any) {
    // Swallow detailed server logs; return minimal error
    return NextResponse.json({ error: e.message || 'failed' }, { status: 500 })
  }
}
