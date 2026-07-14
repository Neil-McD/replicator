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

test('fabricate, slice, export, and print routes use lifecycle command handlers', async () => {
  const [fabricate, slice, exportStl, printNow, handlers] = await Promise.all([
    source('app/api/orders/[id]/fabricate/route.ts'),
    source('app/api/orders/[id]/slice/route.ts'),
    source('app/api/orders/[id]/export-stl/route.ts'),
    source('app/api/orders/[id]/print-now/route.ts'),
    source('lib/lifecycleRouteHandlers.ts'),
  ])

  assert.match(fabricate, /handleFabricationLifecycleRequest\(supabase/)
  assert.doesNotMatch(fabricate, /from\('orders'\)\.update\(\{\s*status:/)
  assert.match(slice, /handleSliceLifecycleRequest\(supabase/)
  assert.doesNotMatch(slice, /from\('export_jobs'\)/)
  assert.match(exportStl, /handleExportLifecycleRequest\(supabase/)
  assert.doesNotMatch(exportStl, /from\('export_jobs'\)/)
  assert.match(printNow, /handlePrintNowRequest\(supabase/)
  assert.match(handlers, /requestFabrication\(supabase/)
  assert.match(handlers, /requestSliceJob\(supabase/)
  assert.match(handlers, /requestExportJob\(supabase/)
  assert.match(handlers, /requestDispatch\(supabase/)
})

test('Stripe persists paid before requesting dispatch and chat cannot mark printing', async () => {
  const [stripe, handlers, chat] = await Promise.all([
    source('app/api/stripe/webhook/route.ts'),
    source('lib/lifecycleRouteHandlers.ts'),
    source('app/api/chat/route.ts'),
  ])
  const paidIndex = handlers.indexOf('await markPaid')
  const dispatchIndex = handlers.indexOf('await requestDispatch', paidIndex)
  assert.ok(paidIndex >= 0 && dispatchIndex > paidIndex)
  assert.match(stripe, /processCompletedCheckout\(supabase/)
  assert.match(chat, /if \(!\(auth\.isAdmin \|\| auth\.isOperator\)\)/)
  assert.match(chat, /requestDispatch\(supabase/)
  assert.doesNotMatch(chat, /update\(\{ status: 'printing'/)
})

test('catalog requests queued export work without directly owning order status', async () => {
  const store = await source('lib/storeOrder.ts')
  assert.match(store, /requestExportJob\(supabase/)
  assert.doesNotMatch(store, /from\('export_jobs'\)/)
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
  assert.match(migration, /create unique index if not exists export_jobs_one_active_job_idx/i)
  assert.match(migration, /create or replace function public\.request_order_job/i)
  assert.match(migration, /where order_id = p_order_id[\s\S]*and job_type = p_job_type[\s\S]*status in \('pending', 'processing'\)/i)
  assert.match(migration, /v_patch \? 'payment_status'[\s\S]*p_transition <> 'payment_completed'/i)
  assert.match(migration, /v_patch \? 'quote_json' and p_transition <> 'quote_ready'/i)
  assert.match(migration, /jsonb_typeof\(v_quote->'minutes'\) <> 'number'/i)
  for (const [transition, contract] of Object.entries(LIFECYCLE_TRANSITIONS)) {
    assert.match(migration, new RegExp(`when '${transition}'[\\s\\S]*?v_required_to := '${contract.to}'`))
  }
})

test('migration replaces the legacy claim RPC safely and keeps worker RPCs service-role-only', async () => {
  const migration = await readFile(
    path.join(repoRoot, 'supabase/migrations/20260714000000_order_lifecycle_transitions.sql'),
    'utf8',
  )

  const legacyDrop = migration.indexOf('drop function if exists public.claim_i23d_task(uuid);')
  const replacement = migration.indexOf('create function public.claim_i23d_task(p_worker_id uuid)')
  assert.ok(legacyDrop >= 0 && replacement > legacyDrop)
  assert.doesNotMatch(migration, /create or replace function public\.claim_i23d_task/)

  for (const signature of [
    'public.transition_order_lifecycle(uuid,text,text[],text,text,text,text,text,jsonb,jsonb)',
    'public.request_order_job(uuid,text,text,uuid,numeric,numeric,uuid,text,text)',
    'public.claim_i23d_task(uuid)',
  ]) {
    const escapedSignature = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(
      migration,
      new RegExp(`revoke all on function ${escapedSignature} from public, anon, authenticated;`, 'i'),
    )
    assert.match(
      migration,
      new RegExp(`grant execute on function ${escapedSignature} to service_role;`, 'i'),
    )
  }
})
