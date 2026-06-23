import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/orders/:id/continue-editing
// Allows user to dismiss the quote and return to editing/resizing the model
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    let auth
    try { auth = await requireAuthContext(req) } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()

    // Access check
    let order
    try {
      order = await requireOrderAccess(supabase, params.id, auth, 'id,user_id,status,quote_json')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    // Only allow continuing editing if currently at quoted
    if (order.status !== 'quoted') {
      return NextResponse.json(
        { error: 'invalid_status', message: 'Can only continue editing from quoted status' },
        { status: 400 }
      )
    }

    // Set status back to materialized via state machine RPC, preserving the quote for reference
    try {
      await supabase.rpc('advance_order', { p_order_id: params.id, p_next: 'materialized', p_meta: { source: 'continue_editing' } })
    } catch (rpcErr: any) {
      return NextResponse.json(
        { error: 'update_failed', message: 'Failed to update order status', detail: rpcErr?.message || null },
        { status: 500 }
      )
    }

    // Log the event
    try {
      await supabase.from('order_events').insert({
        order_id: params.id,
        phase: 'continue_editing',
        message: 'User returned to editing from quote',
      })
    } catch {}

    return NextResponse.json({ ok: true, status: 'materialized' })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
