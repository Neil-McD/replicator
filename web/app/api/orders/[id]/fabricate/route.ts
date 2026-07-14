import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { LifecycleTransitionError, lifecycleHttpStatus, requestFabrication } from '@/lib/lifecycle'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const orderId = params.id
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
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
    const result = await requestFabrication(supabase, orderId, {
      actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
      idempotencyKey: `fabricate:${orderId}`,
      eventMessage: 'User requested fabrication',
      patch: { worker_id: null, locked_at: null, meta_json: { cancel_requested: false } },
    })
    if (result.changed) {
      try {
        await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: 'On it — stabilizing the mesh for a print-ready quote.' } })
      } catch { /* no-op */ }
    }
    return NextResponse.json({ ok: true, status: result.newStatus, reused: result.reused })
  } catch (e: any) {
    if (e instanceof LifecycleTransitionError) {
      return NextResponse.json({ error: e.code }, { status: lifecycleHttpStatus(e) })
    }
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
