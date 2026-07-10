import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { idempotencyKeys, lifecycle } from '@/lib/lifecycle'

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
      .select('id,sha256')
      .eq('order_id', orderId)
      .eq('kind', 'repaired_stl')
      .order('created_at', { ascending: false })
      .limit(1)
    if (!repaired || repaired.length === 0) {
      return NextResponse.json({ error: 'no_repaired_stl', message: 'No repaired STL is available to slice.' }, { status: 409 })
    }

    // Clear cancel flag on explicit slice request
    try {
      const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
      const prev = (row?.meta_json as any) || {}
      const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
      await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
    } catch {}

    const command = await lifecycle.requestSliceQuote({
      supabase,
      orderId,
      actor: auth.user?.id || 'user',
      idempotencyKey: idempotencyKeys.sliceQuote(orderId, repaired[0]?.sha256 || repaired[0]?.id || null, process.env.BAMBUSTUDIO_PROFILE_PATH || 'default', 'env'),
      metadata: { source: 'manual_retry' },
    })

    const commandJobId = command.result?.job_id

    // Check for existing pending/processing slice job after lifecycle validation.
    const { data: existingJobs } = await supabase
      .from('export_jobs')
      .select('id,status')
      .eq('order_id', orderId)
      .eq('job_type', 'slice_quote')
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)

    let jobRow = existingJobs?.[0] ?? null

    if (!jobRow) {
      const { data: insertedJob, error: jobErr } = await supabase
        .from('export_jobs')
        .insert({
          order_id: orderId,
          status: 'pending',
          job_type: 'slice_quote',
          requested_by: auth.user?.id ?? null,
          meta_json: {
            source: 'manual_retry',
            idempotency_key: idempotencyKeys.sliceQuote(orderId, repaired[0]?.sha256 || repaired[0]?.id || null, process.env.BAMBUSTUDIO_PROFILE_PATH || 'default', 'env'),
            requested_at: new Date().toISOString(),
          }
        })
        .select('id,status')
        .single()

      if (jobErr || !insertedJob) {
        throw jobErr || new Error('failed_to_enqueue_slice_job')
      }
      jobRow = insertedJob
    }

    await supabase
      .from('order_events')
      .insert({
        order_id: orderId,
        phase: 'slicing',
        message: 'Print check queued',
        meta_json: { job_id: commandJobId || jobRow.id }
      })

    return NextResponse.json({ ok: true, jobId: commandJobId || jobRow.id, status: jobRow.status, reused: command.reused })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
