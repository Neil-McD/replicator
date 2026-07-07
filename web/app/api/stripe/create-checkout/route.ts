import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { hasSliceDerivedQuote, requireAssetKinds } from '@/lib/orderState'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' })

export async function POST(req: Request) {
  try {
    console.log('[api/stripe/create-checkout POST] start')
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY')
    const body = await req.json()
    const order_id = body?.order_id
    const rawQty = body?.quantity
    console.log('[api/stripe/create-checkout POST] order_id=', order_id)
    if (!order_id) return NextResponse.json({ error: 'order_id required' }, { status: 400 })
    const supabase = createAdminClient()
    const { data: order, error } = await supabase.from('orders').select('id, quote_json, status').eq('id', order_id).single()
    if (error || !order) throw error || new Error('Order not found')
    if (order.status !== 'ready_to_pay') return NextResponse.json({ error: 'Order not ready for payment' }, { status: 400 })
    const quote = order.quote_json as any
    const priceCents = quote?.total_cents ?? quote?.price_cents
    if (!hasSliceDerivedQuote(quote)) return NextResponse.json({ error: 'Missing slice-derived quote metrics' }, { status: 400 })
    if (!priceCents) return NextResponse.json({ error: 'Missing price on order' }, { status: 400 })
    try {
      await requireAssetKinds(supabase, order_id, ['three_mf', 'gcode', 'slicedata', 'slicer_preview_png'])
    } catch (gateErr: any) {
      return NextResponse.json({ error: 'missing_printable_artifacts', missing: gateErr?.missing || [] }, { status: 400 })
    }
    const maxQty = Math.max(1, Number(process.env.CHECKOUT_MAX_QTY || 20))
    const quantity = Math.min(maxQty, Math.max(1, Number(rawQty || 1)))

    const origin = req.headers.get('origin') || 'http://localhost:3000'
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${origin}/orders/${order_id}/buy?success=1`,
      cancel_url: `${origin}/orders/${order_id}/buy?canceled=1`,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: '3D Print Job' },
            unit_amount: priceCents,
          },
          quantity,
        },
      ],
      metadata: { order_id },
    })
    console.log('[api/stripe/create-checkout POST] session=', session.id)
    return NextResponse.json({ id: session.id, url: session.url })
  } catch (e: any) {
    console.error('[api/stripe/create-checkout POST] error:', e?.message)
    return NextResponse.json({ error: e.message || 'failed' }, { status: 500 })
  }
}
