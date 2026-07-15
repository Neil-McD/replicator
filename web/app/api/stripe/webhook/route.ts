import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { processCompletedCheckout } from '@/lib/lifecycleRouteHandlers'

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
      if (session.metadata?.order_id) {
        const supabase = createAdminClient()
        await processCompletedCheckout(supabase, session)
      }
    }
    return new NextResponse(null, { status: 200 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'invalid payload' }, { status: 400 })
  }
}
