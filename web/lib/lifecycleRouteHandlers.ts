import { NextResponse } from 'next/server'
import { signedUrlOrDirect } from '@/lib/supabaseAdmin'
import {
  LifecycleTransitionError,
  lifecycleHttpStatus,
  markPaid,
  requestDispatch,
  requestExportJob,
  requestFabrication,
  requestSliceJob,
} from '@/lib/lifecycle'

const DEFAULT_TARGET_TOLERANCE_MM = 0.1

function normalizeTarget(value: any): number | null {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return null
  return num
}

export async function handleFabricationLifecycleRequest(supabase: any, orderId: string, auth: any) {
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
}

export async function handleSliceLifecycleRequest(supabase: any, orderId: string, auth: any) {
  try {
    const job = await requestSliceJob(supabase, orderId, {
      actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
      requestedBy: auth.user?.id ?? null,
      source: 'manual_retry',
      eventMessage: 'Print check queued',
    })
    return NextResponse.json({
      ok: true,
      jobId: job.jobId,
      status: job.status,
      reused: job.reused,
      lifecycleReused: job.lifecycle.reused,
    })
  } catch (error: any) {
    if (error instanceof LifecycleTransitionError) {
      if (error.code === 'missing_artifact') {
        return NextResponse.json({ error: 'no_repaired_stl', message: 'No repaired STL is available to slice.' }, { status: 409 })
      }
      return NextResponse.json({ error: error.code }, { status: lifecycleHttpStatus(error) })
    }
    throw error
  }
}

export async function handleExportLifecycleRequest(supabase: any, orderId: string, auth: any, body: any) {
  const rawTarget = normalizeTarget(body?.target_max_dim_mm)
  const rawTolerance = normalizeTarget(body?.target_tolerance_mm)
  const maxTarget = Math.max(20, Number(process.env.MAX_TARGET_DIM_MM || 230))
  const target = rawTarget != null ? Math.min(rawTarget, maxTarget) : null
  const tolerance = Math.max(0.1, rawTolerance ?? DEFAULT_TARGET_TOLERANCE_MM)

  try {
    const { data: repaired } = await supabase
      .from('assets')
      .select('id,kind,created_at')
      .eq('order_id', orderId)
      .eq('kind', 'repaired_stl')
      .order('created_at', { ascending: false })
      .limit(1)
    if (!repaired || repaired.length === 0) {
      const { data: assetsBrief } = await supabase
        .from('assets')
        .select('id,kind,created_at')
        .eq('order_id', orderId)
        .order('created_at', { ascending: false })
        .limit(50)
      const kinds = (assetsBrief || []).map((asset: any) => asset.kind)
      return NextResponse.json({
        error: 'no_repaired_stl',
        message: 'No repaired STL available. Generate or upload a model first, or wait for the worker to finish repair.',
        debug: {
          present: {
            raw: kinds.filter((kind: any) => String(kind || '').startsWith('raw_')).length,
            upload_models: kinds.filter((kind: any) => ['upload_stl', 'upload_obj', 'upload_glb'].includes(String(kind))).length,
            images: kinds.filter((kind: any) => kind === 'upload_image').length,
            repaired: 0,
          },
        },
      }, { status: 409 })
    }
  } catch {}

  const job = await requestExportJob(supabase, orderId, {
    actor: auth.isAdmin || auth.isOperator ? 'operator' : 'user',
    requestedBy: auth.user?.id ?? null,
    targetMaxDimMm: target,
    targetToleranceMm: tolerance,
    source: 'stage',
    eventMessage: 'Queued print-ready STL export',
  })
  return NextResponse.json({
    ok: true,
    jobId: job.jobId,
    status: job.status,
    reused: job.reused,
    assetId: job.assetId,
  })
}

export async function handlePrintNowRequest(
  supabase: any,
  auth: any,
  orderId: string,
  signUrl: (url: string) => Promise<string> = signedUrlOrDirect,
) {
  if (!(auth.isAdmin || auth.isOperator)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  try {
    const { error } = await supabase.from('orders').select('id').eq('id', orderId).single()
    if (error) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  } catch {}
  const { data: asset } = await supabase.from('assets').select('*').eq('order_id', orderId).eq('kind', 'three_mf').order('created_at', { ascending: false }).limit(1).single()
  if (!asset) return NextResponse.json({ error: '3MF not found' }, { status: 404 })
  const signed = await signUrl(asset.url)
  const link = `bambu-connect://import-file?file=${encodeURIComponent(signed)}`
  const transition = await requestDispatch(supabase, orderId, {
    actor: 'operator',
    idempotencyKey: `print-now:${asset.id}`,
    eventMessage: 'Operator requested printer dispatch',
    eventMeta: { asset_id: asset.id },
    patch: { worker_id: null, locked_at: null },
  })
  return NextResponse.json({ link, status: transition.newStatus, reused: transition.reused })
}

export async function processCompletedCheckout(supabase: any, session: any) {
  const orderId = session.metadata?.order_id
  if (!orderId) return
  const { data: existingPayments } = await supabase
    .from('payments')
    .select('id')
    .eq('provider_ref', session.id)
    .limit(1)
  if (!existingPayments?.length) {
    await supabase
      .from('payments')
      .insert({ order_id: orderId, provider_ref: session.id, amount_cents: session.amount_total || 0, status: 'succeeded' })
  }
  await markPaid(supabase, orderId, {
    actor: 'stripe',
    idempotencyKey: `stripe:${session.id}:paid`,
    eventMessage: 'Stripe checkout completed',
  })
  await requestDispatch(supabase, orderId, {
    actor: 'system',
    idempotencyKey: `stripe:${session.id}:dispatch`,
    eventMessage: 'Preparing dispatch to printer',
    patch: { worker_id: null, locked_at: null },
  })
}
