import test from 'node:test'
import assert from 'node:assert/strict'
import { handleStoreRequest } from '@/app/api/orders/[id]/store/route'

class StubSupabase {
  tables: Record<string, any>
  updates: Array<{ table: string; payload: any; filters: Array<{ column: string; value: any }> }>
  inserts: Array<{ table: string; payload: any }>
  upserts: Array<{ table: string; payload: any; options?: any }>

  constructor(tables: Record<string, any>) {
    this.tables = tables
    this.updates = []
    this.inserts = []
    this.upserts = []
  }

  from(table: string) {
    const self = this
    const tableData = this.tables[table]
    return new (class {
      filters: Array<{ column: string; value: any }> = []

      select() {
        return this
      }

      order() {
        return this
      }

      limit() {
        return Promise.resolve({ data: tableData ?? [], error: null })
      }

      eq(column: string, value: any) {
        this.filters.push({ column, value })
        return this
      }

      maybeSingle() {
        return Promise.resolve({ data: tableData ?? null, error: null })
      }

      single() {
        return Promise.resolve({ data: tableData ?? null, error: null })
      }

      insert(payload: any) {
        self.inserts.push({ table, payload })
        return Promise.resolve({ data: null, error: null })
      }

      upsert(payload: any, options?: any) {
        self.upserts.push({ table, payload, options })
        return Promise.resolve({ data: null, error: null })
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

  storage = {
    from: () => ({
      copy: async () => ({ error: null }),
      upload: async () => ({ error: null }),
    }),
  }
}

test('handleStoreRequest rejects catalog publish before sliced artifact boundary', async () => {
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
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error, 'slice_quote_required')

  assert.equal(supabase.updates.filter((entry) => entry.table === 'orders').length, 0)
  assert.equal(supabase.upserts.length, 0)
  assert.equal(supabase.inserts.length, 0)
})

test('handleStoreRequest queues sized export only after slice quote and artifacts exist', async () => {
  const orderId = 'order-123'
  const supabase = new StubSupabase({
    orders: {
      id: orderId,
      user_id: 'user-1',
      org_id: 'org-1',
      prompt_text: 'Test prompt',
      material: 'PLA',
      quote_json: { minutes: 73, grams: 41, price_cents: 1840, cost_cents: 1250 },
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
      { id: 'asset-3mf', kind: 'three_mf', url: 'supabase://artifacts/order-123/out.3mf', meta_json: {} },
      { id: 'asset-gcode', kind: 'gcode', url: 'supabase://artifacts/order-123/plate.gcode', meta_json: {} },
      { id: 'asset-slicedata', kind: 'slicedata', url: 'supabase://artifacts/order-123/slicedata.json', meta_json: {} },
      { id: 'asset-preview', kind: 'slicer_preview_png', url: 'supabase://artifacts/order-123/preview.png', meta_json: {} },
    ],
  })

  const auth = { isAdmin: false, user: { id: 'user-1' } }
  const body = {}

  const response = await handleStoreRequest({ supabase: supabase as any, auth, orderId, body })
  assert.equal(response.status, 202)
  const payload = await response.json()
  assert.equal(payload.status, 'pending_export')

  assert.equal(supabase.updates.filter((entry) => entry.table === 'orders').length, 0)
  assert.equal(supabase.upserts.length, 1)
  assert.equal(supabase.upserts[0].table, 'export_jobs')
  assert.equal(supabase.upserts[0].payload.status, 'pending')

  const insertedTables = supabase.inserts.map((entry) => entry.table)
  assert.deepEqual(insertedTables.sort(), ['chat_messages', 'order_events'])
})

test('handleStoreRequest rejects pre-slice orders before checking catalog STL', async () => {
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
  assert.equal(payload.error, 'slice_boundary_required')
})
