import test from 'node:test'
import assert from 'node:assert/strict'
import { ORDER_TRANSITIONS, canTransition } from '@/lib/orderState'

test('every declared transition is accepted for its authorities', () => {
  for (const rule of ORDER_TRANSITIONS) {
    if (rule.from === '*') continue
    for (const authority of rule.authorities) {
      assert.equal(
        canTransition(rule.from, rule.to, authority),
        true,
        `${rule.from} -> ${rule.to} by ${authority}`,
      )
    }
  }
})

test('illegal transitions fail', () => {
  assert.equal(canTransition('new', 'paid', 'stripe'), false)
  assert.equal(canTransition('ready_to_pay', 'dispatching', 'operator'), false)
  assert.equal(canTransition('paid', 'ready_to_pay', 'worker'), false)
  assert.equal(canTransition('done', 'printing', 'worker'), false)
})

test('wrong authority fails', () => {
  assert.equal(canTransition('ready_to_pay', 'paid', 'worker'), false)
  assert.equal(canTransition('paid', 'dispatching', 'stripe'), false)
  assert.equal(canTransition('materializing', 'generating', 'chat'), false)
})
