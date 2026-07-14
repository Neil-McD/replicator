export const ORDER_STATUSES = [
  'new', 'visualizing', 'await_image_pick', 'materializing', 'generating',
  'fabrication_requested', 'repairing', 'exporting', 'slicing', 'stl_ready',
  'ready_to_pay', 'paid', 'dispatching', 'printing', 'done', 'needs_review',
  'generate_failed', 'repair_failed', 'slice_failed', 'dispatch_failed', 'cancelled',
] as const

export type OrderStatus = typeof ORDER_STATUSES[number]

export const LIFECYCLE_TRANSITIONS = {
  visualize_started: { to: 'visualizing', from: ['new', 'await_image_pick', 'stl_ready', 'ready_to_pay', 'generate_failed', 'needs_review'], reusedAt: [] },
  visualize_candidates_ready: { to: 'await_image_pick', from: ['new', 'visualizing'], reusedAt: [] },
  materialize_requested: { to: 'materializing', from: ['await_image_pick', 'visualizing', 'generate_failed', 'needs_review'], reusedAt: [] },
  materialize_claimed: { to: 'generating', from: ['new', 'visualizing', 'await_image_pick', 'materializing', 'generating'], reusedAt: ['generating'] },
  fabrication_requested: { to: 'fabrication_requested', from: ['materializing', 'generating', 'stl_ready', 'generate_failed', 'needs_review'], reusedAt: ['fabrication_requested', 'repairing', 'slicing', 'stl_ready', 'ready_to_pay', 'paid', 'dispatching', 'printing', 'done'] },
  repair_started: { to: 'repairing', from: ['fabrication_requested', 'generating'], reusedAt: ['repairing'] },
  stl_ready: { to: 'stl_ready', from: ['repairing', 'exporting'], reusedAt: ['stl_ready'] },
  export_requested: { to: 'exporting', from: ['stl_ready', 'ready_to_pay', 'needs_review'], reusedAt: ['exporting'] },
  slice_requested: { to: 'slicing', from: ['stl_ready', 'fabrication_requested', 'repairing', 'slice_failed'], reusedAt: ['slicing'] },
  quote_ready: { to: 'ready_to_pay', from: ['slicing'], reusedAt: ['ready_to_pay'] },
  payment_completed: { to: 'paid', from: ['ready_to_pay'], reusedAt: ['paid', 'dispatching', 'printing', 'done'] },
  dispatch_requested: { to: 'dispatching', from: ['paid', 'dispatch_failed'], reusedAt: ['dispatching', 'printing', 'done'] },
  printing_started: { to: 'printing', from: ['dispatching'], reusedAt: ['printing', 'done'] },
  done: { to: 'done', from: ['printing'], reusedAt: ['done'] },
  generate_failed: { to: 'generate_failed', from: ['materializing', 'generating'], reusedAt: ['generate_failed'] },
  repair_failed: { to: 'repair_failed', from: ['fabrication_requested', 'generating', 'repairing'], reusedAt: ['repair_failed'] },
  slice_failed: { to: 'slice_failed', from: ['fabrication_requested', 'repairing', 'slicing'], reusedAt: ['slice_failed'] },
  dispatch_failed: { to: 'dispatch_failed', from: ['paid', 'dispatching'], reusedAt: ['dispatch_failed'] },
  needs_review: { to: 'needs_review', from: ['materializing', 'generating', 'fabrication_requested', 'repairing', 'exporting', 'slicing', 'stl_ready', 'slice_failed'], reusedAt: ['needs_review'] },
  cancelled: { to: 'cancelled', from: ORDER_STATUSES.filter((status) => !['cancelled', 'done'].includes(status)), reusedAt: ['cancelled'] },
} as const satisfies Record<string, { to: OrderStatus; from: readonly OrderStatus[]; reusedAt: readonly OrderStatus[] }>

export type LifecycleTransition = keyof typeof LIFECYCLE_TRANSITIONS

export type LifecycleResult = {
  ok: true
  previousStatus: OrderStatus
  newStatus: OrderStatus
  changed: boolean
  reused: boolean
}

export class LifecycleTransitionError extends Error {
  code: string
  previousStatus?: string

  constructor(code: string, previousStatus?: string) {
    super(code)
    this.name = 'LifecycleTransitionError'
    this.code = code
    this.previousStatus = previousStatus
  }
}

type TransitionInput = {
  orderId: string
  transition: LifecycleTransition
  actor?: string
  idempotencyKey?: string | null
  eventPhase?: string | null
  eventMessage?: string | null
  eventMeta?: Record<string, any>
  patch?: Record<string, any>
}

type SupabaseRpcClient = {
  rpc(name: string, params: Record<string, any>): PromiseLike<{ data: any; error: any }>
}

export async function transitionOrder(supabase: SupabaseRpcClient, input: TransitionInput): Promise<LifecycleResult> {
  const contract = LIFECYCLE_TRANSITIONS[input.transition]
  if (!contract) throw new LifecycleTransitionError('invalid_transition')

  const { data, error } = await supabase.rpc('transition_order_lifecycle', {
    p_order_id: input.orderId,
    p_transition: input.transition,
    p_expected_from: [...contract.from],
    p_to_status: contract.to,
    p_actor: input.actor ?? 'system',
    p_idempotency_key: input.idempotencyKey ?? null,
    p_event_phase: input.eventPhase ?? input.transition,
    p_event_message: input.eventMessage ?? null,
    p_event_meta: input.eventMeta ?? {},
    p_patch: input.patch ?? {},
  })

  if (error) {
    const message = String(error.message || error.code || 'lifecycle_transition_failed')
    const stableCode = ['invalid_transition', 'already_in_progress', 'missing_artifact', 'not_paid', 'forbidden', 'cancelled', 'invalid_quote', 'not_found']
      .find((code) => message.includes(code)) ?? 'lifecycle_transition_failed'
    throw new LifecycleTransitionError(stableCode)
  }
  if (!data?.ok) throw new LifecycleTransitionError(data?.error || 'lifecycle_transition_failed', data?.previous_status)

  return {
    ok: true,
    previousStatus: data.previous_status,
    newStatus: data.new_status,
    changed: Boolean(data.changed),
    reused: Boolean(data.reused),
  }
}

type HelperOptions = Omit<TransitionInput, 'orderId' | 'transition'>

export const requestFabrication = (supabase: SupabaseRpcClient, orderId: string, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'fabrication_requested', eventPhase: 'fabrication_requested', ...options })

export const requestExport = (supabase: SupabaseRpcClient, orderId: string, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'export_requested', eventPhase: 'export_requested', ...options })

export const requestSlice = (supabase: SupabaseRpcClient, orderId: string, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'slice_requested', eventPhase: 'slicing', ...options })

export const markStlReady = (supabase: SupabaseRpcClient, orderId: string, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'stl_ready', eventPhase: 'stl_ready', ...options })

export const markQuoteReady = (supabase: SupabaseRpcClient, orderId: string, quote: Record<string, any>, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'quote_ready', eventPhase: 'ready_to_pay', ...options, patch: { ...(options.patch ?? {}), quote_json: quote } })

export const markPaid = (supabase: SupabaseRpcClient, orderId: string, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'payment_completed', eventPhase: 'paid', ...options, patch: { ...(options.patch ?? {}), payment_status: 'paid' } })

export const requestDispatch = (supabase: SupabaseRpcClient, orderId: string, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'dispatch_requested', eventPhase: 'dispatching', ...options })

export const markPrinting = (supabase: SupabaseRpcClient, orderId: string, options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: 'printing_started', eventPhase: 'printing', ...options })

export const markFailure = (supabase: SupabaseRpcClient, orderId: string, failure: 'generate_failed' | 'repair_failed' | 'slice_failed' | 'dispatch_failed' | 'needs_review', options: HelperOptions = {}) =>
  transitionOrder(supabase, { orderId, transition: failure, eventPhase: failure, ...options })

export function lifecycleHttpStatus(error: unknown): number {
  if (!(error instanceof LifecycleTransitionError)) return 500
  if (error.code === 'forbidden') return 403
  if (error.code === 'not_found') return 404
  if (error.code === 'not_paid') return 402
  if (error.code === 'missing_artifact' || error.code === 'invalid_transition' || error.code === 'cancelled' || error.code === 'invalid_quote') return 409
  return 500
}
