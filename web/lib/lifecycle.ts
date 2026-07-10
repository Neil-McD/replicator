import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export const ORDER_STATUSES = [
  'new',
  'visualizing',
  'await_image_pick',
  'materializing',
  'stabilizing',
  'slicing',
  'ready_to_pay',
  'paid',
  'dispatching',
  'printing',
  'done',
  'needs_review',
  'generate_failed',
  'repair_failed',
  'slice_failed',
  'dispatch_failed',
  'cancelled',
] as const

export type OrderStatus = typeof ORDER_STATUSES[number]

export const DEPRECATED_STATUS_MAP: Record<string, OrderStatus> = {
  generating: 'materializing',
  fabrication_requested: 'stabilizing',
  repairing: 'stabilizing',
  exporting: 'stabilizing',
  stl_ready: 'ready_to_pay',
}

export type LifecycleCommand =
  | 'createOrder'
  | 'requestVisualization'
  | 'recordVisualizationSucceeded'
  | 'selectImageForMaterialization'
  | 'recordProviderTaskQueued'
  | 'recordProviderTaskSucceeded'
  | 'recordProviderTaskFailed'
  | 'requestStabilization'
  | 'requestExportStl'
  | 'recordRepairSucceeded'
  | 'recordRepairFailed'
  | 'requestSliceQuote'
  | 'recordSliceQuoteSucceeded'
  | 'recordSliceQuoteFailed'
  | 'authorizePayment'
  | 'requestDispatch'
  | 'recordDispatchIssued'
  | 'recordPrintingStarted'
  | 'recordPrintDone'
  | 'cancelOrder'
  | 'publishCatalogVersion'
  | 'ingestStorefrontOrder'
  | 'requestChannelSync'

type TransitionRule = {
  from: OrderStatus[]
  to: OrderStatus
}

const ACTIVE_STATUSES: OrderStatus[] = [
  'new',
  'visualizing',
  'await_image_pick',
  'materializing',
  'stabilizing',
  'slicing',
  'ready_to_pay',
  'paid',
  'dispatching',
  'printing',
]

const TRANSITIONS: Record<LifecycleCommand, TransitionRule | null> = {
  createOrder: null,
  requestVisualization: { from: ['new', 'await_image_pick', 'generate_failed', 'needs_review'], to: 'visualizing' },
  recordVisualizationSucceeded: { from: ['new', 'visualizing', 'await_image_pick'], to: 'await_image_pick' },
  selectImageForMaterialization: { from: ['await_image_pick', 'generate_failed', 'needs_review'], to: 'materializing' },
  recordProviderTaskQueued: null,
  recordProviderTaskSucceeded: { from: ['materializing'], to: 'stabilizing' },
  recordProviderTaskFailed: { from: ['visualizing', 'materializing'], to: 'generate_failed' },
  requestStabilization: { from: ['new', 'await_image_pick', 'materializing', 'stabilizing', 'ready_to_pay', 'repair_failed', 'needs_review'], to: 'stabilizing' },
  requestExportStl: null,
  recordRepairSucceeded: { from: ['stabilizing'], to: 'slicing' },
  recordRepairFailed: { from: ['stabilizing'], to: 'repair_failed' },
  requestSliceQuote: { from: ['stabilizing', 'ready_to_pay', 'slice_failed', 'needs_review'], to: 'slicing' },
  recordSliceQuoteSucceeded: { from: ['slicing'], to: 'ready_to_pay' },
  recordSliceQuoteFailed: { from: ['slicing'], to: 'slice_failed' },
  authorizePayment: { from: ['ready_to_pay'], to: 'paid' },
  requestDispatch: { from: ['ready_to_pay', 'paid', 'dispatch_failed'], to: 'dispatching' },
  recordDispatchIssued: { from: ['dispatching'], to: 'dispatching' },
  recordPrintingStarted: { from: ['dispatching'], to: 'printing' },
  recordPrintDone: { from: ['printing'], to: 'done' },
  cancelOrder: { from: ACTIVE_STATUSES, to: 'cancelled' },
  publishCatalogVersion: null,
  ingestStorefrontOrder: null,
  requestChannelSync: null,
}

export type TransitionInput = {
  supabase: SupabaseClient<any, any, any>
  orderId: string
  command: LifecycleCommand
  actor: string
  idempotencyKey: string
  metadata?: Record<string, any> | null
  result?: Record<string, any> | null
  allowNoop?: boolean
}

export function normalizeOrderStatus(status: string | null | undefined): OrderStatus {
  const raw = String(status || 'new').trim()
  if ((ORDER_STATUSES as readonly string[]).includes(raw)) return raw as OrderStatus
  return DEPRECATED_STATUS_MAP[raw] || 'needs_review'
}

export function canTransition(fromStatus: string | null | undefined, command: LifecycleCommand): boolean {
  const rule = TRANSITIONS[command]
  if (!rule) return true
  return rule.from.includes(normalizeOrderStatus(fromStatus))
}

export function targetStatusFor(command: LifecycleCommand): OrderStatus | null {
  return TRANSITIONS[command]?.to ?? null
}

export function hashForIdempotency(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export const idempotencyKeys = {
  visualization(orderId: string, prompt: string, style: string | null | undefined, n: number) {
    return `order:${orderId}:visualize:${hashForIdempotency({ prompt })}:${style || ''}:${n}`
  },
  materialization(orderId: string, imageIds: string[], provider: string | null | undefined) {
    return `order:${orderId}:i23d:${hashForIdempotency([...imageIds].sort())}:${provider || ''}`
  },
  sliceQuote(orderId: string, printableAssetSha: string | null | undefined, profileHash: string | null | undefined, pricingHash: string | null | undefined) {
    return `order:${orderId}:slice_quote:${printableAssetSha || 'unknown'}:${profileHash || 'default'}:${pricingHash || 'default'}`
  },
  payment(orderId: string, providerRef: string) {
    return `order:${orderId}:payment:${providerRef}`
  },
  stripeCheckoutSession(sessionId: string) {
    return `stripe_checkout_session:${sessionId}`
  },
  dispatch(orderId: string, threeMfSha: string | null | undefined) {
    return `order:${orderId}:dispatch:${threeMfSha || 'unknown'}`
  },
  catalogPublish(productId: string, orderId: string, artifactSetHash: string, priceHash: string) {
    return `product:${productId}:version_from_order:${orderId}:${artifactSetHash}:${priceHash}`
  },
}

async function findCompletedCommand(supabase: SupabaseClient<any, any, any>, key?: string | null) {
  if (!key) return null
  try {
    const { data } = await supabase
      .from('order_commands')
      .select('key,command,order_id,status,result_json')
      .eq('key', key)
      .maybeSingle()
    if (data && data.status === 'succeeded') return data
  } catch {
    return null
  }
  return null
}

function assertCommandBoundary(input: TransitionInput) {
  if (!input.actor || !String(input.actor).trim()) {
    throw new Error(`missing_actor:${input.command}`)
  }
  if (!input.idempotencyKey || !String(input.idempotencyKey).trim()) {
    throw new Error(`missing_idempotency_key:${input.command}`)
  }
}

async function recordCommand(
  supabase: SupabaseClient<any, any, any>,
  input: TransitionInput,
  status: 'started' | 'succeeded' | 'failed',
  result?: Record<string, any> | null,
) {
  try {
    await supabase.from('order_commands').upsert({
      key: input.idempotencyKey,
      command: input.command,
      order_id: input.orderId,
      status,
      actor: input.actor || null,
      metadata_json: input.metadata || {},
      result_json: result || {},
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' })
  } catch {
    // Deploys may run before the migration. The lifecycle transition still owns status.
  }
}

async function enqueueExportJobForCommand(input: TransitionInput) {
  const jobType =
    input.command === 'requestStabilization' ? 'repair'
    : input.command === 'requestSliceQuote' ? 'slice_quote'
    : input.command === 'requestDispatch' ? 'dispatch'
    : null
  if (!jobType) return null

  try {
    const { data: existing } = await input.supabase
      .from('export_jobs')
      .select('id,status,job_type')
      .eq('order_id', input.orderId)
      .eq('job_type', jobType)
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
    if (existing && existing.length > 0) return existing[0]

    const { data, error } = await input.supabase
      .from('export_jobs')
      .insert({
        order_id: input.orderId,
        status: 'pending',
        job_type: jobType,
        requested_by: input.actor || null,
        meta_json: {
          source: input.command,
          idempotency_key: input.idempotencyKey,
          ...(input.metadata || {}),
          requested_at: new Date().toISOString(),
        },
      })
      .select('id,status,job_type')
      .single()
    if (error) throw error
    return data
  } catch {
    // The command owns the lifecycle transition. Job insertion is best-effort in
    // tests and pre-migration deployments, and API routes may already enqueue.
    return null
  }
}

export async function runLifecycleCommand(input: TransitionInput): Promise<{ status: OrderStatus | null; reused: boolean; result?: any }> {
  assertCommandBoundary(input)
  const completed = await findCompletedCommand(input.supabase, input.idempotencyKey)
  if (completed) return { status: null, reused: true, result: completed.result_json }

  const target = targetStatusFor(input.command)
  await recordCommand(input.supabase, input, 'started')
  if (!target) {
    const result = input.result || {}
    await recordCommand(input.supabase, input, 'succeeded', result)
    return { status: null, reused: false, result }
  }

  const { data: order, error } = await input.supabase
    .from('orders')
    .select('id,status')
    .eq('id', input.orderId)
    .single()
  if (error || !order) {
    await recordCommand(input.supabase, input, 'failed', { error: 'order_not_found' })
    throw error || new Error('order_not_found')
  }

  const current = normalizeOrderStatus(order.status)
  if (current === target && input.allowNoop !== false) {
    await recordCommand(input.supabase, input, 'succeeded', { status: target, noop: true })
    return { status: target, reused: false, result: { status: target, noop: true } }
  }
  if (!canTransition(current, input.command)) {
    const message = `invalid_transition:${current}:${input.command}:${target}`
    await recordCommand(input.supabase, input, 'failed', { error: message })
    throw new Error(message)
  }

  const { data: updatedOrder, error: updateError } = await input.supabase
    .from('orders')
    .update({ status: target })
    .eq('id', input.orderId)
    .eq('status', order.status)
    .neq('status', 'cancelled')
    .select('id,status')
    .maybeSingle()
  if (updateError) {
    await recordCommand(input.supabase, input, 'failed', { error: updateError.message })
    throw updateError
  }
  if (!updatedOrder) {
    const message = `stale_transition:${current}:${input.command}:${target}`
    await recordCommand(input.supabase, input, 'failed', { error: message })
    throw new Error(message)
  }

  const job = await enqueueExportJobForCommand(input)
  const result = { ...(input.result || {}), status: target, ...(job ? { job_id: job.id, job_type: job.job_type } : {}) }
  await recordCommand(input.supabase, input, 'succeeded', result)
  return { status: target, reused: false, result }
}

export const lifecycle = {
  requestVisualization: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'requestVisualization' }),
  recordVisualizationSucceeded: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'recordVisualizationSucceeded' }),
  selectImageForMaterialization: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'selectImageForMaterialization' }),
  recordProviderTaskQueued: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'recordProviderTaskQueued' }),
  recordProviderTaskSucceeded: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'recordProviderTaskSucceeded' }),
  recordProviderTaskFailed: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'recordProviderTaskFailed' }),
  requestStabilization: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'requestStabilization' }),
  requestExportStl: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'requestExportStl' }),
  requestSliceQuote: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'requestSliceQuote' }),
  recordSliceQuoteSucceeded: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'recordSliceQuoteSucceeded' }),
  recordSliceQuoteFailed: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'recordSliceQuoteFailed' }),
  authorizePayment: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'authorizePayment' }),
  requestDispatch: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'requestDispatch' }),
  recordPrintingStarted: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'recordPrintingStarted' }),
  cancelOrder: (input: Omit<TransitionInput, 'command'>) => runLifecycleCommand({ ...input, command: 'cancelOrder' }),
}
