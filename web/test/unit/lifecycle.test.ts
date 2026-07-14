import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LifecycleTransitionError,
  markQuoteReady,
  requestDispatch,
  requestFabrication,
  requestExportJob,
  requestSliceJob,
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

test('slice work is requested through one atomic lifecycle and queue RPC', async () => {
  const client = new RpcStub({
    ok: true,
    job_id: 'slice-job-1',
    job_status: 'pending',
    reused: false,
    completed: false,
    lifecycle: { ok: true, previous_status: 'stl_ready', new_status: 'slicing', changed: true, reused: false },
  })

  const result = await requestSliceJob(client, 'order-7', { requestedBy: 'user-1', source: 'route' })

  assert.equal(result.jobId, 'slice-job-1')
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].name, 'request_order_job')
  assert.equal(client.calls[0].params.p_job_type, 'slice')
})

test('concurrent duplicate requests reuse the one active database job', async () => {
  let calls = 0
  const client = {
    async rpc() {
      calls += 1
      return {
        data: {
          ok: true,
          job_id: 'one-active-job',
          job_status: calls === 1 ? 'pending' : 'processing',
          reused: calls > 1,
          completed: false,
          lifecycle: {
            ok: true,
            previous_status: calls === 1 ? 'stl_ready' : 'slicing',
            new_status: 'slicing',
            changed: calls === 1,
            reused: calls > 1,
          },
        },
        error: null,
      }
    },
  }

  const [first, second] = await Promise.all([
    requestSliceJob(client, 'order-8'),
    requestSliceJob(client, 'order-8'),
  ])
  assert.equal(first.jobId, second.jobId)
  assert.equal(second.reused, true)
})

test('invalid job transition fails without a successful queue result', async () => {
  const client = new RpcStub({ ok: false, error: 'invalid_transition', previous_status: 'new' })
  await assert.rejects(
    () => requestExportJob(client, 'order-9'),
    (error: any) => error instanceof LifecycleTransitionError && error.code === 'invalid_transition',
  )
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].name, 'request_order_job')
})

test('completed export reuse returns its existing asset without creating a new job', async () => {
  const client = new RpcStub({
    ok: true,
    job_id: 'completed-export',
    job_status: 'succeeded',
    asset_id: 'sized-stl-1',
    reused: true,
    completed: true,
    lifecycle: { ok: true, previous_status: 'exporting', new_status: 'stl_ready', changed: true, reused: false },
  })
  const result = await requestExportJob(client, 'order-10', { targetMaxDimMm: 120 })
  assert.equal(result.completed, true)
  assert.equal(result.assetId, 'sized-stl-1')
  assert.equal(client.calls.length, 1)
})
