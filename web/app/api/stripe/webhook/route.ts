import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { transitionOrder } from '@/lib/orderState'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2023-10-16' })
  const sig = (await headers()).get('stripe-signature')
  if (!process.env.STRIPE_WEBHOOK_SECRET) return NextResponse.json({ error: 'Missing STRIPE_WEBHOOK_SECRET' }, { status: 400 })
  if (!sig) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  try {
    const body = await req.text()
    const event = await stripe.webhooks.constructEventAsync(body, sig, process.env.STRIPE_WEBHOOK_SECRET)
    console.log('[api/stripe/webhook POST] event=', event.type)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session
      const order_id = session.metadata?.order_id
      if (order_id) {
        const supabase = createAdminClient()
        const { data: orderRow, error: orderErr } = await supabase
          .from('orders')
          .select('id,status,quote_json')
          .eq('id', order_id)
          .single()
        if (orderErr || !orderRow) throw orderErr || new Error('order_not_found')
        const expectedAmount = Number((orderRow.quote_json as any)?.total_cents ?? (orderRow.quote_json as any)?.price_cents)
        const paidAmount = Number(session.amount_total || 0)
        if (orderRow.status !== 'ready_to_pay' && orderRow.status !== 'paid') {
          throw new Error(`invalid_order_status:${orderRow.status}`)
        }
        if (Number.isFinite(expectedAmount) && expectedAmount > 0 && expectedAmount !== paidAmount) {
          throw new Error('payment_amount_mismatch')
        }
        await supabase
          .from('payments')
          .upsert({ order_id, provider_ref: session.id, amount_cents: paidAmount, status: 'succeeded' }, { onConflict: 'provider_ref' })
        await transitionOrder(supabase, {
          orderId: order_id,
          to: 'paid',
          authority: 'stripe',
          expectedFrom: ['ready_to_pay', 'paid'],
          idempotencyKey: `stripe:checkout.session.completed:${session.id}`,
          meta: { provider_ref: session.id, amount_cents: paidAmount },
        })
        await supabase
          .from('orders')
          .update({ payment_status: 'paid' })
          .eq('id', order_id)
        await supabase
          .from('order_events')
          .insert([
            { order_id, phase: 'paid', message: 'Stripe checkout completed' },
          ])
        await supabase
          .from('chat_messages')
          .insert({ order_id, role: 'assistant', type: 'text', content_json: { text: 'Authorized. Fabrication is ready for operator dispatch.' } })
      }
    }
    return new NextResponse(null, { status: 200 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'invalid payload' }, { status: 400 })
  }
}
