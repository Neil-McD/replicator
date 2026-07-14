import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { markPaid, requestDispatch } from '@/lib/lifecycle'

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
        const { data: existingPayments } = await supabase
          .from('payments')
          .select('id')
          .eq('provider_ref', session.id)
          .limit(1)
        if (!existingPayments?.length) {
          await supabase
            .from('payments')
            .insert({ order_id, provider_ref: session.id, amount_cents: session.amount_total || 0, status: 'succeeded' })
        }
        await markPaid(supabase, order_id, {
          actor: 'stripe',
          idempotencyKey: `stripe:${session.id}:paid`,
          eventMessage: 'Stripe checkout completed',
        })
        await requestDispatch(supabase, order_id, {
          actor: 'system',
          idempotencyKey: `stripe:${session.id}:dispatch`,
          eventMessage: 'Preparing dispatch to printer',
          patch: { worker_id: null, locked_at: null },
        })
      }
    }
    return new NextResponse(null, { status: 200 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'invalid payload' }, { status: 400 })
  }
}
