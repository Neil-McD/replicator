import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { hashForIdempotency, lifecycle } from '@/lib/lifecycle'

const DEFAULT_TARGET_TOLERANCE_MM = 0.1

function normalizeTarget(value: any): number | null {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return num
}

function approxMatch(a: number | null, b: number | null, tolerance: number): boolean {
  if (a == null || b == null) return false
  return Math.abs(a - b) <= tolerance
}

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
    const rawTarget = normalizeTarget(body?.target_max_dim_mm)
    const rawTolerance = normalizeTarget(body?.target_tolerance_mm)
    const maxTarget = Math.max(20, Number(process.env.MAX_TARGET_DIM_MM || 230))
    const target = rawTarget != null ? Math.min(rawTarget, maxTarget) : null
    const tolerance = Math.max(0.1, rawTolerance ?? DEFAULT_TARGET_TOLERANCE_MM)

    // Clear any prior cancel flag since the user explicitly requested a new export
    try {
      const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
      const prev = (row?.meta_json as any) || {}
      const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
      await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
    } catch {}

    // Guard: require a repaired STL to exist before queuing an export.
    // This mirrors the worker's expectation (it reads latest 'repaired_stl').
    try {
      const { data: repaired } = await supabase
        .from('assets')
        .select('id,kind,sha256,created_at')
        .eq('order_id', orderId)
        .eq('kind', 'repaired_stl')
        .order('created_at', { ascending: false })
        .limit(1)
      if (!repaired || repaired.length === 0) {
        // Collect minimal debug hints to help the client/UI
        const { data: assetsBrief } = await supabase
          .from('assets')
          .select('id,kind,created_at')
          .eq('order_id', orderId)
          .order('created_at', { ascending: false })
          .limit(50)
        const kinds = (assetsBrief || []).map((a: any) => a.kind)
        const present = {
          raw: kinds.filter((k) => String(k||'').startsWith('raw_')).length,
          upload_models: kinds.filter((k) => ['upload_stl','upload_obj','upload_glb'].includes(String(k))).length,
          images: kinds.filter((k) => k === 'upload_image').length,
          repaired: 0,
        }
        return NextResponse.json({
          error: 'no_repaired_stl',
          message: 'No repaired STL available. Generate or upload a model first, or wait for the worker to finish repair.',
          debug: { present }
        }, { status: 409 })
      }
    } catch {}

    // Record/refresh transform so the worker applies most recent intent
    let transformAssetId: string | null = null
    if (target != null) {
      const { data: transformRow, error: transformErr } = await supabase
        .from('assets')
        .insert({ order_id: orderId, kind: 'transform', url: '', meta_json: { target_max_dim_mm: target } })
        .select('id')
        .single()
      if (!transformErr && transformRow?.id) {
        transformAssetId = transformRow.id
      }
    }

    // Reuse an in-flight job if the same target is already pending/processing
    const { data: existingJobs, error: jobsErr } = await supabase
      .from('export_jobs')
      .select('id,status,target_max_dim_mm,asset_id,completed_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(10)

    if (jobsErr) {
      console.warn('[export-stl] failed to load existing jobs', jobsErr)
    }

    const jobs = Array.isArray(existingJobs) ? existingJobs : []
    const pendingJob = jobs.find((job: any) => ['pending', 'processing'].includes(String(job.status || '').toLowerCase()) && approxMatch(normalizeTarget(job.target_max_dim_mm), target, tolerance))
    if (pendingJob) {
      return NextResponse.json({ ok: true, jobId: pendingJob.id, status: pendingJob.status, reused: true })
    }

    const succeededJob = jobs.find((job: any) => String(job.status || '').toLowerCase() === 'succeeded' && job.asset_id && approxMatch(normalizeTarget(job.target_max_dim_mm), target, tolerance))
    if (succeededJob) {
      return NextResponse.json({ ok: true, jobId: succeededJob.id, status: succeededJob.status, reused: true, assetId: succeededJob.asset_id })
    }

    const insertPayload: any = {
      order_id: orderId,
      status: 'pending',
      job_type: 'export_stl',
      target_max_dim_mm: target,
      target_tolerance_mm: tolerance,
      requested_by: auth.user?.id ?? null,
      transform_asset_id: transformAssetId,
      meta_json: { source: 'stage', requested_at: new Date().toISOString() },
    }

    await lifecycle.requestExportStl({
      supabase,
      orderId,
      actor: auth.user?.id || 'user',
      idempotencyKey: `order:${orderId}:export_stl:${hashForIdempotency({ target, tolerance, transformAssetId })}`,
      metadata: { target_max_dim_mm: target, tolerance_mm: tolerance, transform_asset_id: transformAssetId },
    })

    // Supersede older pending/processing export jobs for this order.
    try {
      await supabase
        .from('export_jobs')
        .update({ status: 'cancelled' })
        .eq('order_id', orderId)
        .in('status', ['pending','processing'])
    } catch {}

    const { data: jobRow, error: jobErr } = await supabase
      .from('export_jobs')
      .insert(insertPayload)
      .select('*')
      .single()
    if (jobErr || !jobRow) {
      throw jobErr || new Error('failed_to_enqueue_export_job')
    }

    await supabase.from('order_events').insert({
      order_id: orderId,
      phase: 'export_stl',
      message: 'Queued print-ready STL export',
      meta_json: { job_id: jobRow.id, target_max_dim_mm: target, tolerance_mm: tolerance },
    })
    return NextResponse.json({ ok: true, jobId: jobRow.id, status: jobRow.status })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
