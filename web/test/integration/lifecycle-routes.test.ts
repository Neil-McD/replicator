import test from 'node:test'
import assert from 'node:assert/strict'
import {
  handleExportLifecycleRequest,
  handleFabricationLifecycleRequest,
  handlePrintNowRequest,
  handleSliceLifecycleRequest,
  processCompletedCheckout,
} from '@/lib/lifecycleRouteHandlers'

function lifecycleResult(previous: string, next: string, reused = false) {
  return { ok: true, previous_status: previous, new_status: next, changed: !reused, reused }
}

test('fabricate route behavior returns idempotent reuse without duplicate chat output', async () => {
  let chatWrites = 0
  const supabase = {
    async rpc(name: string) {
      assert.equal(name, 'transition_order_lifecycle')
      return { data: lifecycleResult('repairing', 'repairing', true), error: null }
    },
    from(table: string) {
      assert.equal(table, 'chat_messages')
      return { insert: async () => { chatWrites += 1 } }
    },
  }
  const response = await handleFabricationLifecycleRequest(
    supabase,
    'order-fabricate',
    { isAdmin: false, isOperator: false, user: { id: 'user-1' } },
  )
  assert.equal(response.status, 200)
  assert.equal((await response.json()).reused, true)
  assert.equal(chatWrites, 0)
})

test('slice route behavior reuses the active slice job', async () => {
  const supabase = {
    async rpc(name: string) {
      assert.equal(name, 'request_order_job')
      return {
        data: {
          ok: true,
          job_id: 'slice-active',
          job_status: 'processing',
          reused: true,
          completed: false,
          lifecycle: lifecycleResult('slicing', 'slicing', true),
        },
        error: null,
      }
    },
  }
  const response = await handleSliceLifecycleRequest(
    supabase,
    'order-slice',
    { isAdmin: false, isOperator: false, user: { id: 'user-1' } },
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    jobId: 'slice-active',
    status: 'processing',
    reused: true,
    lifecycleReused: true,
  })
})

test('slice route behavior rejects a missing repaired STL', async () => {
  const supabase = {
    async rpc() {
      return { data: { ok: false, error: 'missing_artifact', previous_status: 'stl_ready' }, error: null }
    },
  }
  const response = await handleSliceLifecycleRequest(
    supabase,
    'order-no-stl',
    { isAdmin: false, isOperator: false, user: { id: 'user-1' } },
  )
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'no_repaired_stl')
})

test('export route behavior reuses a completed same-size export and returns its asset', async () => {
  const supabase = {
    from(table: string) {
      assert.equal(table, 'assets')
      return {
        select() { return this },
        eq() { return this },
        order() { return this },
        async limit() { return { data: [{ id: 'repaired-1', kind: 'repaired_stl' }], error: null } },
      }
    },
    async rpc(name: string) {
      assert.equal(name, 'request_order_job')
      return {
        data: {
          ok: true,
          job_id: 'export-complete',
          job_status: 'succeeded',
          asset_id: 'sized-stl-1',
          reused: true,
          completed: true,
          lifecycle: lifecycleResult('exporting', 'stl_ready'),
        },
        error: null,
      }
    },
  }
  const response = await handleExportLifecycleRequest(
    supabase,
    'order-export',
    { isAdmin: false, isOperator: false, user: { id: 'user-1' } },
    {},
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    jobId: 'export-complete',
    status: 'succeeded',
    reused: true,
    assetId: 'sized-stl-1',
  })
})

test('print-now route behavior rejects a non-operator before database access', async () => {
  const supabase = new Proxy({}, {
    get() {
      throw new Error('database should not be accessed')
    },
  })
  const response = await handlePrintNowRequest(
    supabase,
    { isAdmin: false, isOperator: false, user: { id: 'user-1' } },
    'order-print',
  )
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'forbidden')
})

test('Stripe checkout records payment, marks paid, then requests dispatch', async () => {
  const operations: string[] = []
  const supabase = {
    from(table: string) {
      assert.equal(table, 'payments')
      return {
        select() { return this },
        eq() { return this },
        async limit() { return { data: [], error: null } },
        async insert(payload: any) {
          assert.equal(payload.status, 'succeeded')
          operations.push('payment_recorded')
          return { error: null }
        },
      }
    },
    async rpc(name: string, params: any) {
      assert.equal(name, 'transition_order_lifecycle')
      operations.push(params.p_transition)
      const next = params.p_transition === 'payment_completed' ? 'paid' : 'dispatching'
      return { data: lifecycleResult(params.p_transition === 'payment_completed' ? 'ready_to_pay' : 'paid', next), error: null }
    },
  }

  await processCompletedCheckout(supabase, {
    id: 'cs_test_1',
    amount_total: 1840,
    metadata: { order_id: 'order-paid' },
  } as any)

  assert.deepEqual(operations, ['payment_recorded', 'payment_completed', 'dispatch_requested'])
})
