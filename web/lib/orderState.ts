import type { SupabaseClient } from '@supabase/supabase-js'

export const ORDER_STATUSES = [
  'new',
  'visualizing',
  'await_image_pick',
  'materializing',
  'generating',
  'repairing',
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

export const TRANSITION_AUTHORITIES = [
  'chat',
  'visualize',
  'materialize',
  'worker',
  'stripe',
  'operator',
  'user',
  'catalog',
] as const

export type TransitionAuthority = typeof TRANSITION_AUTHORITIES[number]

type TransitionRule = {
  from: OrderStatus | '*'
  to: OrderStatus
  authorities: readonly TransitionAuthority[]
  gate: string
  sideEffect: string
}

export const ORDER_TRANSITIONS: readonly TransitionRule[] = [
  { from: 'new', to: 'visualizing', authorities: ['chat', 'visualize'], gate: 'authenticated safe prompt/upload', sideEffect: 'assistant text/event' },
  { from: 'await_image_pick', to: 'visualizing', authorities: ['chat', 'visualize'], gate: 'authenticated safe retry/remix', sideEffect: 'assistant text/event' },
  { from: 'generate_failed', to: 'visualizing', authorities: ['chat', 'visualize'], gate: 'explicit retry', sideEffect: 'assistant text/event' },
  { from: 'repair_failed', to: 'visualizing', authorities: ['chat', 'visualize'], gate: 'explicit retry', sideEffect: 'assistant text/event' },
  { from: 'slice_failed', to: 'visualizing', authorities: ['chat', 'visualize'], gate: 'explicit retry', sideEffect: 'assistant text/event' },
  { from: 'needs_review', to: 'visualizing', authorities: ['chat', 'visualize'], gate: 'review cleared retry', sideEffect: 'assistant text/event' },
  { from: 'visualizing', to: 'await_image_pick', authorities: ['visualize', 'chat'], gate: '1-6 candidate images stored', sideEffect: 'card.images' },
  { from: 'await_image_pick', to: 'materializing', authorities: ['materialize', 'chat'], gate: 'selected images belong to order', sideEffect: 'card.job and i23d task' },
  { from: 'materializing', to: 'generating', authorities: ['worker'], gate: 'queued i23d task claimed', sideEffect: 'worker lock' },
  { from: 'generating', to: 'repairing', authorities: ['worker'], gate: 'raw mesh asset exists', sideEffect: 'viewer/event' },
  { from: 'generating', to: 'generate_failed', authorities: ['worker'], gate: 'provider failed or no valid raw mesh', sideEffect: 'warning' },
  { from: 'generating', to: 'needs_review', authorities: ['worker'], gate: 'manual/security review condition', sideEffect: 'warning' },
  { from: 'repairing', to: 'slicing', authorities: ['worker'], gate: 'repaired_stl exists and gates pass', sideEffect: 'viewer focus/enqueue slice' },
  { from: 'slice_failed', to: 'slicing', authorities: ['worker'], gate: 'explicit retry and repaired_stl exists', sideEffect: 'enqueue slice' },
  { from: 'repairing', to: 'repair_failed', authorities: ['worker'], gate: 'repair attempts exhausted', sideEffect: 'warning' },
  { from: 'repairing', to: 'needs_review', authorities: ['worker'], gate: 'thin wall/unit/manual issue', sideEffect: 'warning' },
  { from: 'slicing', to: 'ready_to_pay', authorities: ['worker'], gate: 'Bambu minutes/grams and printable artifacts stored', sideEffect: 'card.quote' },
  { from: 'slicing', to: 'slice_failed', authorities: ['worker'], gate: 'Bambu failed or metrics/artifacts missing', sideEffect: 'warning' },
  { from: 'ready_to_pay', to: 'paid', authorities: ['stripe'], gate: 'valid checkout session for quote amount', sideEffect: 'Authorized text' },
  { from: 'paid', to: 'dispatching', authorities: ['operator', 'worker'], gate: 'paid plus three_mf/gcode/slicedata/quote', sideEffect: 'bambu-connect link' },
  { from: 'dispatching', to: 'printing', authorities: ['operator', 'worker'], gate: 'operator accepted link or printer acknowledged', sideEffect: 'printing event' },
  { from: 'printing', to: 'done', authorities: ['operator', 'worker'], gate: 'operator/printer completion', sideEffect: 'final chat message' },
  { from: '*', to: 'cancelled', authorities: ['user', 'operator'], gate: 'before terminal/paid/printing unless operator override', sideEffect: 'cancellation event' },
]

const TERMINAL_STATUSES = new Set<OrderStatus>(['done', 'cancelled'])
const STATUS_SET = new Set<string>(ORDER_STATUSES)
const AUTHORITY_SET = new Set<string>(TRANSITION_AUTHORITIES)

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && STATUS_SET.has(value)
}

export function canTransition(from: string | null | undefined, to: OrderStatus, authority: TransitionAuthority): boolean {
  if (!isOrderStatus(to) || !AUTHORITY_SET.has(authority)) return false
  if (from && !isOrderStatus(from)) return false
  const fromStatus: OrderStatus | null = from ? (from as OrderStatus) : null
  if (fromStatus && TERMINAL_STATUSES.has(fromStatus) && fromStatus !== to) return false
  if (fromStatus === to) return true
  return ORDER_TRANSITIONS.some((rule) => {
    const fromOk = rule.from === '*' || rule.from === fromStatus
    return fromOk && rule.to === to && rule.authorities.includes(authority)
  })
}

export async function getOrderStatus(
  supabase: SupabaseClient<any, any, any>,
  orderId: string,
): Promise<OrderStatus | null> {
  const { data, error } = await supabase.from('orders').select('status').eq('id', orderId).single()
  if (error) throw error
  const status = data?.status
  return isOrderStatus(status) ? status : null
}

export async function transitionOrder(
  supabase: SupabaseClient<any, any, any>,
  input: {
    orderId: string
    to: OrderStatus
    authority: TransitionAuthority
    expectedFrom?: OrderStatus | OrderStatus[] | null
    idempotencyKey: string
    meta?: Record<string, any>
  },
) {
  const expected = Array.isArray(input.expectedFrom)
    ? input.expectedFrom
    : input.expectedFrom
      ? [input.expectedFrom]
      : null
  const payload = {
    p_order_id: input.orderId,
    p_to_status: input.to,
    p_authority: input.authority,
    p_expected_from: expected,
    p_idempotency_key: input.idempotencyKey,
    p_meta_json: input.meta || {},
  }
  const { data, error } = await supabase.rpc('transition_order', payload)
  if (error) throw error
  return data
}

export async function requireAssetKinds(
  supabase: SupabaseClient<any, any, any>,
  orderId: string,
  kinds: string[],
): Promise<Record<string, any>> {
  const { data, error } = await supabase
    .from('assets')
    .select('id,kind,url,sha256,meta_json,created_at')
    .eq('order_id', orderId)
    .in('kind', kinds)
    .order('created_at', { ascending: false })
  if (error) throw error
  const found: Record<string, any> = {}
  for (const row of data || []) {
    if (!found[row.kind]) found[row.kind] = row
  }
  const missing = kinds.filter((kind) => !found[kind])
  if (missing.length) {
    const err = new Error(`missing_assets:${missing.join(',')}`) as Error & { missing?: string[] }
    err.missing = missing
    throw err
  }
  return found
}

export function hasSliceDerivedQuote(quote: any): boolean {
  const minutes = Number(quote?.minutes)
  const grams = Number(quote?.grams)
  const cents = Number(quote?.total_cents ?? quote?.price_cents)
  return Number.isFinite(minutes) && minutes > 0 && Number.isFinite(grams) && grams > 0 && Number.isFinite(cents) && cents > 0
}
