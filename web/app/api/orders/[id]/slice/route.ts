import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { LifecycleTransitionError, lifecycleHttpStatus, requestSlice } from '@/lib/lifecycle'

export const runtime = 'nodejs'

// POST /api/orders/:id/slice
// Re-run the print check (slice+quote) on the latest repaired STL.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const orderId = params.id
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

    // Guard: require a repaired STL to exist
    const { data: repaired } = await supabase
      .from('assets')
      .select('id')
      .eq('order_id', orderId)
      .eq('kind', 'repaired_stl')
      .order('created_at', { ascending: false })
      .limit(1)
    if (!repaired || repaired.length === 0) {
      return NextResponse.json({ error: 'no_repaired_stl', message: 'No repaired STL is available to slice.' }, { status: 409 })
    }

    // Check for existing pending/processing slice job (idempotent)
    const { data: existingJobs } = await supabase
      .from('export_jobs')
      .select('id,status')
      .eq('order_id', orderId)
      .eq('job_type', 'slice')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)

    if (existingJobs && existingJobs.length > 0) {
      const existing = existingJobs[0]
      const transition = await requestSlice(supabase, orderId, {
        actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
        idempotencyKey: `slice:${existing.id}`,
        eventMessage: 'Print check already queued',
        patch: { meta_json: { cancel_requested: false } },
      })
      return NextResponse.json({
        ok: true,
        jobId: existing.id,
        status: existing.status,
        reused: true,
        lifecycleReused: transition.reused,
      })
    }

    // Create new slice job in export_jobs queue
    const { data: jobRow, error: jobErr } = await supabase
      .from('export_jobs')
      .insert({
        order_id: orderId,
        status: 'pending',
        job_type: 'slice',
        requested_by: auth.user?.id ?? null,
        meta_json: { source: 'manual_retry', requested_at: new Date().toISOString() }
      })
      .select('*')
      .single()

    if (jobErr || !jobRow) {
      throw jobErr || new Error('failed_to_enqueue_slice_job')
    }

    await requestSlice(supabase, orderId, {
      actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
      idempotencyKey: `slice:${jobRow.id}`,
      eventMessage: 'Print check queued',
      eventMeta: { job_id: jobRow.id },
      patch: { meta_json: { cancel_requested: false } },
    })

    return NextResponse.json({ ok: true, jobId: jobRow.id, status: jobRow.status })
  } catch (e: any) {
    if (e instanceof LifecycleTransitionError) {
      return NextResponse.json({ error: e.code }, { status: lifecycleHttpStatus(e) })
    }
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
