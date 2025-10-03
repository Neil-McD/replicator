import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/orders/:id/cancel
// Best-effort, idempotent signal from the client to cancel any UI-initiated long actions
// (uploads/streams/exports). Worker should treat this as advisory and check flags server-side.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    let auth
    try { auth = await requireAuthContext(req) } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    // Access check (RLS enforced on read/write via service role + manual check)
    try {
      await requireOrderAccess(supabase, params.id, auth, 'id,user_id,status')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    // Record a timeline event for traceability. Idempotent on client retries.
    const body = await req.json().catch(() => ({})) as any
    const reason = typeof body?.reason === 'string' ? body.reason : 'client_cancel'
    try {
      await supabase.from('order_events').insert({
        order_id: params.id,
        phase: 'cancel_requested',
        message: `Client requested cancel (${reason})`,
      })
    } catch {}

    // Persist a soft cancel flag on the order so the worker can honor it without
    // forcefully changing the user-visible status to 'cancelled'.
    try {
      const { data: row } = await supabase
        .from('orders')
        .select('meta_json')
        .eq('id', params.id)
        .single()
      const prev = (row?.meta_json as any) || {}
      const next = {
        ...(typeof prev === 'object' && prev ? prev : {}),
        cancel_requested: true,
        cancel_reason: reason,
        cancel_requested_at: new Date().toISOString(),
      }
      await supabase.from('orders').update({ meta_json: next }).eq('id', params.id)
    } catch {}

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
