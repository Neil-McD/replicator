import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { LifecycleTransitionError, lifecycleHttpStatus } from '@/lib/lifecycle'
import { handleExportLifecycleRequest } from '@/lib/lifecycleRouteHandlers'

export const runtime = 'nodejs'

// POST /api/orders/:id/export-stl
// Body: { target_max_dim_mm?: number }
// Behavior: records (or updates) a transform and sets status='exporting'
// so the worker creates a sized print‑ready STL (repaired_sized_stl).
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const orderId = params.id
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    const { data: orderRow, error: orderErr } = await supabase
      .from('orders')
      .select('id,user_id')
      .eq('id', orderId)
      .single()
    if (orderErr || !orderRow) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    if (!auth.isAdmin && orderRow.user_id && orderRow.user_id !== auth.user.id) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const body = await req.json().catch(() => ({})) as any
    return await handleExportLifecycleRequest(supabase, orderId, auth, body)
  } catch (e: any) {
    if (e instanceof LifecycleTransitionError) {
      return NextResponse.json({ error: e.code }, { status: lifecycleHttpStatus(e) })
    }
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
