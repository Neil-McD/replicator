import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(process.cwd(), '..')

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`create or replace function public.${name}`)
  assert.notEqual(start, -1, `${name} function exists`)
  const end = source.indexOf('$$;', start)
  assert.notEqual(end, -1, `${name} function body terminates`)
  return source.slice(start, end)
}

test('legacy claim_next_order cannot directly mutate core order status', () => {
  const schema = readRepoFile('supabase/schema.sql')
  const migration = readRepoFile('supabase/migrations/20260707090000_deterministic_order_state.sql')

  for (const source of [schema, migration]) {
    const body = extractFunction(source, 'claim_next_order')
    assert.doesNotMatch(body, /update\s+public\.orders[\s\S]*\bstatus\s*=/i)
    assert.match(body, /claimed\s*:=\s*null/i)
  }
})

test('worker does not manually process queued i23d tasks after claim RPC failure', () => {
  const worker = readRepoFile('worker/main.py')
  const claimStart = worker.indexOf('def claim_next_order()')
  const claimEnd = worker.indexOf('\ndef set_status', claimStart)
  assert.ok(claimStart >= 0 && claimEnd > claimStart, 'claim_next_order body exists')
  const body = worker.slice(claimStart, claimEnd)

  assert.doesNotMatch(body, /supabase_get\("generation_tasks",\s*\{"status":\s*"eq\.queued",\s*"kind":\s*"eq\.i23d"/)
  assert.doesNotMatch(body, /\{"status":\s*"running",\s*"worker_id":\s*WORKER_ID/)
  assert.match(body, /claim_i23d_task is the[\s\S]*only valid i23d claim path/i)
  assert.doesNotMatch(body, /"status":\s*"eq\.new"/)
})

test('chat prompt does not instruct the model to call disabled slice or dispatch tools', () => {
  const route = readRepoFile('web/app/api/chat/route.ts')
  const promptStart = route.indexOf('const SYSTEM_PROMPT = `')
  const promptEnd = route.indexOf('`\n\nconst ATTACHMENT_PROMPT', promptStart)
  assert.ok(promptStart >= 0 && promptEnd > promptStart, 'SYSTEM_PROMPT exists')
  const prompt = route.slice(promptStart, promptEnd)

  assert.doesNotMatch(prompt, /run slice_and_quote automatically/i)
  assert.doesNotMatch(prompt, /proceed to slice_and_quote/i)
  assert.match(prompt, /non-authoritative for MVP-critical state changes/i)
})

test('worker status transitions use deterministic idempotency keys, not timestamps', () => {
  const worker = readRepoFile('worker/main.py')
  const setStatusStart = worker.indexOf('def set_status(')
  const setStatusEnd = worker.indexOf('\ndef extract_slice_artifact_bytes', setStatusStart)
  assert.ok(setStatusStart >= 0 && setStatusEnd > setStatusStart, 'set_status body exists')
  const body = worker.slice(setStatusStart, setStatusEnd)

  assert.doesNotMatch(body, /int\(time\.time\(\)\)/)
  assert.match(body, /worker:\{order_id\}:\{current_status or 'unknown'\}:\{target_status\}/)
  assert.match(body, /expected_from=\[current_status\] if current_status else None/)
})

test('cancel route uses canonical transition instead of soft-only cancellation', () => {
  const route = readRepoFile('web/app/api/orders/[id]/cancel/route.ts')

  assert.match(route, /transitionOrder\(supabase,\s*\{/)
  assert.match(route, /to:\s*'cancelled'/)
  assert.match(route, /authority:\s*'user'/)
  assert.match(route, /phase:\s*'cancelled'/)
  assert.doesNotMatch(route, /forcefully changing the user-visible status to 'cancelled'/)
})

test('worker cannot ignore canonical cancelled status for active i23d tasks', () => {
  const worker = readRepoFile('worker/main.py')
  const start = worker.indexOf('def _skip_if_cancelled(')
  const end = worker.indexOf('\ndef attach_asset', start)
  assert.ok(start >= 0 && end > start, '_skip_if_cancelled body exists')
  const body = worker.slice(start, end)

  assert.match(body, /status_val,\s*flag\s*=\s*_fetch_order_state\(order_id\)/)
  assert.match(body, /status_val and status_val\.lower\(\) == "cancelled"[\s\S]*return True/)
  assert.match(body, /if flag:[\s\S]*_has_active_i23d_task\(order_id\)/)
})
