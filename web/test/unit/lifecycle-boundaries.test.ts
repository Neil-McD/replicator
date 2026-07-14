import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { LIFECYCLE_TRANSITIONS } from '@/lib/lifecycle'

const webRoot = process.cwd()
const repoRoot = path.resolve(webRoot, '..')

async function source(relativePath: string) {
  return readFile(path.join(webRoot, relativePath), 'utf8')
}

test('fabricate, slice, export, and print routes use lifecycle commands', async () => {
  const [fabricate, slice, exportStl, printNow] = await Promise.all([
    source('app/api/orders/[id]/fabricate/route.ts'),
    source('app/api/orders/[id]/slice/route.ts'),
    source('app/api/orders/[id]/export-stl/route.ts'),
    source('app/api/orders/[id]/print-now/route.ts'),
  ])

  assert.match(fabricate, /requestFabrication\(supabase/)
  assert.doesNotMatch(fabricate, /from\('orders'\)\.update\(\{\s*status:/)
  assert.match(slice, /requestSlice\(supabase/)
  assert.match(slice, /\.eq\('job_type', 'slice'\)/)
  assert.match(exportStl, /requestExport\(supabase/)
  assert.match(exportStl, /\.eq\('job_type', 'export'\)[\s\S]*\.in\('status', \['pending','processing'\]\)/)
  assert.match(printNow, /auth\.isAdmin \|\| auth\.isOperator/)
  assert.match(printNow, /requestDispatch\(supabase/)
})

test('Stripe persists paid before requesting dispatch and chat cannot mark printing', async () => {
  const [stripe, chat] = await Promise.all([
    source('app/api/stripe/webhook/route.ts'),
    source('app/api/chat/route.ts'),
  ])
  const paidIndex = stripe.indexOf('await markPaid')
  const dispatchIndex = stripe.indexOf('await requestDispatch')
  assert.ok(paidIndex >= 0 && dispatchIndex > paidIndex)
  assert.match(chat, /if \(!\(auth\.isAdmin \|\| auth\.isOperator\)\)/)
  assert.match(chat, /requestDispatch\(supabase/)
  assert.doesNotMatch(chat, /update\(\{ status: 'printing'/)
})

test('catalog requests queued export work without directly owning order status', async () => {
  const store = await source('lib/storeOrder.ts')
  assert.match(store, /from\('export_jobs'\)/)
  assert.match(store, /requestExport\(supabase/)
  assert.doesNotMatch(store, /from\('orders'\)\.update\(\{\s*status: 'exporting'/)
})

test('migration command locks orders and enforces payment, artifact, and server-only gates', async () => {
  const migration = await readFile(
    path.join(repoRoot, 'supabase/migrations/20260714000000_order_lifecycle_transitions.sql'),
    'utf8',
  )
  assert.match(migration, /for update;/i)
  assert.match(migration, /v_from = 'cancelled'/)
  assert.match(migration, /p_transition = 'quote_ready'/)
  assert.match(migration, /from public\.payments/)
  assert.match(migration, /kind = 'three_mf'/)
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated;/i)
  assert.match(migration, /grant execute on function[\s\S]*to service_role;/i)
  for (const [transition, contract] of Object.entries(LIFECYCLE_TRANSITIONS)) {
    assert.match(migration, new RegExp(`when '${transition}'[\\s\\S]*?v_required_to := '${contract.to}'`))
  }
})
