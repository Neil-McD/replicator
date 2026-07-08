import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { transitionOrder, type OrderStatus } from '@/lib/orderState'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/orders/:id/cancel
const USER_CANCELLABLE_STATUSES = new Set<OrderStatus>([
  'new',
  'visualizing',
  'await_image_pick',
  'materializing',
  'generating',
  'repairing',
  'slicing',
  'ready_to_pay',
  'needs_review',
  'generate_failed',
  'repair_failed',
  'slice_failed',
  'dispatch_failed',
])

// POST /api/orders/:id/cancel
// Canonical user cancellation. The meta flag is retained as advisory detail,
// but the protected terminal status is written through transition_order.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    let auth
    try { auth = await requireAuthContext(req) } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    // Access check (RLS enforced on read/write via service role + manual check)
    let order: any
    try {
      order = await requireOrderAccess(supabase, params.id, auth, 'id,user_id,status,meta_json')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    const body = await req.json().catch(() => ({})) as any
    const reason = typeof body?.reason === 'string' ? body.reason : 'client_cancel'
    const currentStatus = String(order?.status || '')
    if (currentStatus === 'cancelled') {
      return NextResponse.json({ ok: true, status: 'cancelled' })
    }
    if (!USER_CANCELLABLE_STATUSES.has(currentStatus as OrderStatus)) {
      return NextResponse.json({ error: 'not_cancellable', status: currentStatus }, { status: 409 })
    }

    await transitionOrder(supabase, {
      orderId: params.id,
      to: 'cancelled',
      authority: 'user',
      expectedFrom: currentStatus as OrderStatus,
      idempotencyKey: `user:cancel:${params.id}:${currentStatus}:${reason}`,
      meta: { reason },
    })

    try {
      const prev = (order?.meta_json as any) || {}
      const next = {
        ...(typeof prev === 'object' && prev ? prev : {}),
        cancel_requested: true,
        cancel_reason: reason,
        cancel_requested_at: new Date().toISOString(),
      }
      await supabase.from('orders').update({ meta_json: next }).eq('id', params.id)
    } catch {}

    await supabase.from('order_events').insert({
      order_id: params.id,
      phase: 'cancelled',
      message: `Order cancelled (${reason})`,
    })
    await supabase.from('chat_messages').insert({
      order_id: params.id,
      role: 'assistant',
      type: 'text',
      content_json: { text: 'Cancelled.' },
    })

    return NextResponse.json({ ok: true, status: 'cancelled' })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
