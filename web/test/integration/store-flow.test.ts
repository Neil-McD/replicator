import test from 'node:test'
import assert from 'node:assert/strict'
import { handleStoreRequest } from '@/lib/storeOrder'

class StubSupabase {
  tables: Record<string, any>
  updates: Array<{ table: string; payload: any; filters: Array<{ column: string; value: any }> }>
  inserts: Array<{ table: string; payload: any }>
  rpcCalls: Array<{ name: string; params: any }>

  constructor(tables: Record<string, any>) {
    this.tables = tables
    this.updates = []
    this.inserts = []
    this.rpcCalls = []
  }

  from(table: string) {
    const self = this
    const tableData = this.tables[table]
    return new (class {
      filters: Array<{ column: string; value: any }> = []
      insertedPayload: any = null

      select() {
        return this
      }

      order() {
        return this
      }

      limit() {
        return Promise.resolve({ data: tableData ?? [], error: null })
      }

      in(column: string, value: any) {
        this.filters.push({ column, value })
        return this
      }

      eq(column: string, value: any) {
        this.filters.push({ column, value })
        return this
      }

      maybeSingle() {
        return Promise.resolve({ data: tableData ?? null, error: null })
      }

      single() {
        if (this.insertedPayload) {
          return Promise.resolve({ data: { id: `${table}-1`, ...this.insertedPayload }, error: null })
        }
        return Promise.resolve({ data: tableData ?? null, error: null })
      }

      insert(payload: any) {
        self.inserts.push({ table, payload })
        this.insertedPayload = payload
        return this
      }

      update(payload: any) {
        const initialFilters = [...this.filters]
        return {
          eq: async (column: string, value: any) => {
            const finalFilters = [...initialFilters, { column, value }]
            self.updates.push({ table, payload, filters: finalFilters })
            return { error: null }
          },
        }
      }
    })()
  }

  async rpc(name: string, params: any) {
    this.rpcCalls.push({ name, params })
    return {
      data: {
        ok: true,
        job_id: 'export_jobs-1',
        job_status: 'pending',
        reused: false,
        completed: false,
        lifecycle: {
          ok: true,
          previous_status: 'ready_to_pay',
          new_status: 'exporting',
          changed: true,
          reused: false,
        },
      },
      error: null,
    }
  }

  storage = {
    from: () => ({
      copy: async () => ({ error: null }),
      upload: async () => ({ error: null }),
    }),
  }
}

test('handleStoreRequest queues export when only repaired STL exists', async () => {
  const orderId = 'order-123'
  const supabase = new StubSupabase({
    orders: {
      id: orderId,
      user_id: 'user-1',
      org_id: 'org-1',
      prompt_text: 'Test prompt',
      material: 'PLA',
      quote_json: {},
      meta_json: {},
      style: null,
      chosen_image_id: null,
      status: 'ready_to_pay',
    },
    assets: [
      {
        id: 'asset-stl',
        kind: 'repaired_stl',
        url: 'supabase://artifacts/order-123/mesh.stl',
        meta_json: {},
      },
    ],
  })

  const auth = { isAdmin: false, user: { id: 'user-1' } }
  const body = {}

  const response = await handleStoreRequest({ supabase: supabase as any, auth, orderId, body })
  assert.equal(response.status, 202)
  const payload = await response.json()
  assert.equal(payload.status, 'pending_export')

  assert.equal(supabase.updates.length, 0)
  assert.equal(supabase.rpcCalls.length, 1)
  assert.equal(supabase.rpcCalls[0].name, 'request_order_job')
  assert.equal(supabase.rpcCalls[0].params.p_job_type, 'export')

  const insertedTables = supabase.inserts.map((entry) => entry.table)
  assert.deepEqual(insertedTables, ['chat_messages'])
})

test('handleStoreRequest rejects when no repaired STL is available', async () => {
  const orderId = 'order-234'
  const supabase = new StubSupabase({
    orders: {
      id: orderId,
      user_id: 'user-1',
      org_id: 'org-1',
      prompt_text: 'Another prompt',
      material: 'PLA',
      quote_json: {},
      meta_json: {},
      style: null,
      chosen_image_id: null,
      status: 'visualizing',
    },
    assets: [],
  })

  const auth = { isAdmin: false, user: { id: 'user-1' } }
  const body = {}

  const response = await handleStoreRequest({ supabase: supabase as any, auth, orderId, body })
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error, 'sized_asset_missing')
})

test('handleStoreRequest reuses an active catalog export job', async () => {
  const orderId = 'order-345'
  const supabase = new StubSupabase({
    orders: {
      id: orderId,
      user_id: 'user-1',
      org_id: 'org-1',
      prompt_text: 'Reusable export',
      material: 'PLA',
      quote_json: {},
      meta_json: {},
      style: null,
      chosen_image_id: null,
      status: 'exporting',
    },
    assets: [{ id: 'asset-stl', kind: 'repaired_stl', url: 'supabase://artifacts/order-345/mesh.stl', meta_json: {} }],
    export_jobs: [{ id: 'existing-export', status: 'pending' }],
  })
  supabase.rpc = async (name: string, params: any) => {
    supabase.rpcCalls.push({ name, params })
    return {
      data: {
        ok: true,
        job_id: 'existing-export',
        job_status: 'pending',
        reused: true,
        completed: false,
        lifecycle: { ok: true, previous_status: 'exporting', new_status: 'exporting', changed: false, reused: true },
      },
      error: null,
    }
  }

  const response = await handleStoreRequest({
    supabase: supabase as any,
    auth: { isAdmin: false, user: { id: 'user-1' } },
    orderId,
    body: {},
  })
  assert.equal(response.status, 202)
  assert.equal(supabase.inserts.filter((entry) => entry.table === 'chat_messages').length, 0)
  assert.equal(supabase.rpcCalls[0].name, 'request_order_job')
})
