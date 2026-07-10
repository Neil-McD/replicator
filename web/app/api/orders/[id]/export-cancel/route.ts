import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'

export const runtime = 'nodejs'

// POST /api/orders/:id/export-cancel
// Cancels any pending/processing export jobs for this order and nudges status back to an editable state.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const orderId = params.id
  try {
    // Auth
    let auth
    try { auth = await requireAuthContext(_req) } catch (err: any) {
      const status = Number(err?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    // Verify ownership
    const { data: orderRow, error: orderErr } = await supabase
      .from('orders')
      .select('id,user_id,status')
      .eq('id', orderId)
      .single()
    if (orderErr || !orderRow) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (!auth.isAdmin && orderRow.user_id && orderRow.user_id !== auth.user.id) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    // Cancel pending/processing export jobs
    await supabase
      .from('export_jobs')
      .update({ status: 'cancelled' })
      .eq('order_id', orderId)
      .in('status', ['pending', 'processing'])

    // If we already have a printable STL, report it; lifecycle readiness still comes from slice/quote.
    const { data: assets } = await supabase
      .from('assets')
      .select('id,kind')
      .eq('order_id', orderId)
      .in('kind', ['repaired_sized_stl','repaired_stl'])
      .order('created_at', { ascending: false })
      .limit(1)
    const printable = (assets || []).length > 0
    await supabase.from('order_events').insert({
      order_id: orderId,
      phase: 'export_cancelled',
      message: 'User cancelled pending sized STL export via refresh',
    })
    return NextResponse.json({ ok: true, printable })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
