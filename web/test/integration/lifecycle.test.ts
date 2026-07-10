import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canTransition,
  idempotencyKeys,
  lifecycle,
  normalizeOrderStatus,
  targetStatusFor,
} from '@/lib/lifecycle'

class LifecycleStubSupabase {
  orderStatus: string
  commands = new Map<string, any>()
  updates: any[] = []

  constructor(status = 'new') {
    this.orderStatus = status
  }

  from(table: string) {
    const self = this
    return new (class {
      filters: Array<{ column: string; value: any; op?: string }> = []
      payload: any = null

      select() {
        return this
      }

      eq(column: string, value: any) {
        this.filters.push({ column, value, op: 'eq' })
        return this
      }

      neq(column: string, value: any) {
        this.filters.push({ column, value, op: 'neq' })
        return this
      }

      single() {
        if (table !== 'orders') return Promise.resolve({ data: null, error: null })
        return Promise.resolve({ data: { id: 'order-1', status: self.orderStatus }, error: null })
      }

      maybeSingle() {
        if (table !== 'order_commands') return Promise.resolve({ data: null, error: null })
        const key = this.filters.find((f) => f.column === 'key')?.value
        return Promise.resolve({ data: self.commands.get(key) || null, error: null })
      }

      update(payload: any) {
        this.payload = payload
        return this
      }

      upsert(payload: any) {
        if (table === 'order_commands') {
          self.commands.set(payload.key, payload)
        }
        return Promise.resolve({ data: payload, error: null })
      }

      async then(resolve: any) {
        if (table === 'orders' && this.payload?.status) {
          self.orderStatus = this.payload.status
          self.updates.push({ table, payload: this.payload, filters: this.filters })
        }
        resolve({ data: null, error: null })
      }
    })()
  }
}

test('lifecycle transition table allows canonical path and rejects skips', () => {
  assert.equal(targetStatusFor('requestVisualization'), 'visualizing')
  assert.equal(canTransition('new', 'requestVisualization'), true)
  assert.equal(canTransition('visualizing', 'recordVisualizationSucceeded'), true)
  assert.equal(canTransition('await_image_pick', 'selectImageForMaterialization'), true)
  assert.equal(canTransition('materializing', 'recordProviderTaskSucceeded'), true)
  assert.equal(canTransition('stabilizing', 'requestSliceQuote'), true)
  assert.equal(canTransition('slicing', 'recordSliceQuoteSucceeded'), true)
  assert.equal(canTransition('ready_to_pay', 'authorizePayment'), true)
  assert.equal(canTransition('paid', 'requestDispatch'), true)
  assert.equal(canTransition('dispatching', 'recordPrintingStarted'), true)
  assert.equal(canTransition('printing', 'recordPrintDone'), true)

  assert.equal(canTransition('new', 'authorizePayment'), false)
  assert.equal(canTransition('await_image_pick', 'requestDispatch'), false)
  assert.equal(canTransition('paid', 'recordSliceQuoteSucceeded'), false)
})

test('deprecated customer statuses normalize to canonical lifecycle states', () => {
  assert.equal(normalizeOrderStatus('generating'), 'materializing')
  assert.equal(normalizeOrderStatus('fabrication_requested'), 'stabilizing')
  assert.equal(normalizeOrderStatus('repairing'), 'stabilizing')
  assert.equal(normalizeOrderStatus('exporting'), 'stabilizing')
  assert.equal(normalizeOrderStatus('stl_ready'), 'ready_to_pay')
  assert.equal(normalizeOrderStatus('unknown_state'), 'needs_review')
})

test('lifecycle command idempotency returns original result for duplicate command', async () => {
  const supabase = new LifecycleStubSupabase('ready_to_pay') as any
  const key = idempotencyKeys.payment('order-1', 'checkout-123')

  const first = await lifecycle.authorizePayment({
    supabase,
    orderId: 'order-1',
    idempotencyKey: key,
    actor: 'stripe',
  })
  assert.equal(first.status, 'paid')
  assert.equal(supabase.orderStatus, 'paid')
  assert.equal(supabase.updates.length, 1)

  const second = await lifecycle.authorizePayment({
    supabase,
    orderId: 'order-1',
    idempotencyKey: key,
    actor: 'stripe',
  })
  assert.equal(second.reused, true)
  assert.equal(supabase.updates.length, 1)
})
