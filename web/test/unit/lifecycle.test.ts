import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LifecycleTransitionError,
  markQuoteReady,
  requestDispatch,
  requestFabrication,
  transitionOrder,
} from '@/lib/lifecycle'

class RpcStub {
  calls: Array<{ name: string; params: Record<string, any> }> = []
  response: { data: any; error: any }

  constructor(data: any, error: any = null) {
    this.response = { data, error }
  }

  async rpc(name: string, params: Record<string, any>) {
    this.calls.push({ name, params })
    return this.response
  }
}

test('valid lifecycle transition succeeds through the authoritative RPC', async () => {
  const client = new RpcStub({ ok: true, previous_status: 'generating', new_status: 'fabrication_requested', changed: true, reused: false })
  const result = await requestFabrication(client, 'order-1', { actor: 'user' })
  assert.equal(result.newStatus, 'fabrication_requested')
  assert.equal(result.changed, true)
  assert.equal(client.calls[0].name, 'transition_order_lifecycle')
  assert.deepEqual(client.calls[0].params.p_expected_from, ['materializing', 'generating', 'stl_ready', 'generate_failed', 'needs_review'])
})

test('invalid lifecycle transition returns a stable invalid_transition error', async () => {
  const client = new RpcStub({ ok: false, error: 'invalid_transition', previous_status: 'new' })
  await assert.rejects(
    () => requestFabrication(client, 'order-2'),
    (error: any) => error instanceof LifecycleTransitionError && error.code === 'invalid_transition' && error.previousStatus === 'new',
  )
})

test('idempotent transition reports reused without a state change', async () => {
  const client = new RpcStub({ ok: true, previous_status: 'repairing', new_status: 'repairing', changed: false, reused: true })
  const result = await requestFabrication(client, 'order-3')
  assert.equal(result.reused, true)
  assert.equal(result.changed, false)
  assert.equal(result.newStatus, 'repairing')
})

test('cancelled order rejects a non-cancel transition', async () => {
  const client = new RpcStub({ ok: false, error: 'cancelled', previous_status: 'cancelled' })
  await assert.rejects(
    () => requestFabrication(client, 'order-4'),
    (error: any) => error instanceof LifecycleTransitionError && error.code === 'cancelled',
  )
})

test('quote_ready sends the complete quote as an atomic lifecycle patch', async () => {
  const client = new RpcStub({ ok: true, previous_status: 'slicing', new_status: 'ready_to_pay', changed: true, reused: false })
  const quote = { minutes: 73, grams: 41, total_cents: 1840 }
  await markQuoteReady(client, 'order-5', quote)
  assert.deepEqual(client.calls[0].params.p_patch.quote_json, quote)
  assert.equal(client.calls[0].params.p_transition, 'quote_ready')
})

test('dispatch_requested preserves not_paid and missing-artifact errors from the command', async () => {
  const notPaid = new RpcStub({ ok: false, error: 'not_paid', previous_status: 'ready_to_pay' })
  await assert.rejects(
    () => requestDispatch(notPaid, 'order-6', { actor: 'operator' }),
    (error: any) => error instanceof LifecycleTransitionError && error.code === 'not_paid',
  )

  const missing = new RpcStub({ ok: false, error: 'missing_artifact', previous_status: 'paid' })
  await assert.rejects(
    () => transitionOrder(missing, { orderId: 'order-6', transition: 'dispatch_requested', actor: 'operator' }),
    (error: any) => error instanceof LifecycleTransitionError && error.code === 'missing_artifact',
  )
})
