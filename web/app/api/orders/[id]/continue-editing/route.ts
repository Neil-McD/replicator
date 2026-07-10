import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { lifecycle } from '@/lib/lifecycle'

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

    // Only allow continuing editing if currently at ready_to_pay
    if (order.status !== 'ready_to_pay') {
      return NextResponse.json(
        { error: 'invalid_status', message: 'Can only continue editing from ready_to_pay status' },
        { status: 400 }
      )
    }

    await lifecycle.requestStabilization({
      supabase,
      orderId: params.id,
      actor: auth.user?.id || 'user',
      idempotencyKey: `order:${params.id}:stabilize:continue_editing`,
      metadata: { source: 'continue_editing' },
    })

    // Log the event
    try {
      await supabase.from('order_events').insert({
        order_id: params.id,
        phase: 'continue_editing',
        message: 'User returned to editing from quote',
      })
    } catch {}

    return NextResponse.json({ ok: true, status: 'stabilizing' })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
