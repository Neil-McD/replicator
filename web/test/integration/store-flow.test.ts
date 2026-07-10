import test from 'node:test'
import assert from 'node:assert/strict'
import { handleStoreRequest } from '@/lib/storePublish'

class StubSupabase {
  tables: Record<string, any>
  updates: Array<{ table: string; payload: any; filters: Array<{ column: string; value: any }> }>
  inserts: Array<{ table: string; payload: any }>

  constructor(tables: Record<string, any>) {
    this.tables = tables
    this.updates = []
    this.inserts = []
  }

  from(table: string) {
    const self = this
    const tableData = this.tables[table]
    return new (class {
      filters: Array<{ column: string; value: any }> = []
      payload: any = null

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
        if (table === 'order_commands') return Promise.resolve({ data: null, error: null })
        return Promise.resolve({ data: tableData ?? null, error: null })
      }

      single() {
        if (this.payload && table === 'products') {
          return Promise.resolve({ data: { id: this.payload.id || 'product-1' }, error: null })
        }
        if (this.payload && table === 'product_versions') {
          return Promise.resolve({ data: { id: 'version-1' }, error: null })
        }
        return Promise.resolve({ data: tableData ?? null, error: null })
      }

      insert(payload: any) {
        this.payload = payload
        self.inserts.push({ table, payload })
        return this
      }

      upsert(payload: any) {
        this.payload = payload
        self.inserts.push({ table, payload })
        return Promise.resolve({ data: payload, error: null })
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

test('handleStoreRequest rejects ready publish when only repaired STL exists', async () => {
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
  const body = { status: 'ready', visibility: 'public' }

  const response = await handleStoreRequest({ supabase, auth, orderId, body })
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error, 'three_mf_missing')
  assert.equal(supabase.updates.length, 0)
  assert.equal(supabase.inserts.length, 0)
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

  const response = await handleStoreRequest({ supabase, auth, orderId, body })
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error, 'sized_asset_missing')
})

test('handleStoreRequest records publish command before product mutation', async () => {
  const orderId = 'order-345'
  const supabase = new StubSupabase({
    orders: {
      id: orderId,
      user_id: 'user-1',
      org_id: 'org-1',
      prompt_text: 'Ready prompt',
      material: 'PLA',
      quote_json: { minutes: 73, grams: 41, price_cents: 1840, total_cents: 1840 },
      meta_json: {},
      style: null,
      chosen_image_id: null,
      status: 'ready_to_pay',
    },
    assets: [
      { id: 'asset-stl', kind: 'repaired_stl', url: 'supabase://artifacts/order-345/mesh.stl', sha256: 'sha-stl', meta_json: {} },
      { id: 'asset-3mf', kind: 'three_mf', url: 'supabase://artifacts/order-345/plate.3mf', sha256: 'sha-3mf', meta_json: {} },
      { id: 'asset-preview', kind: 'slicer_preview_png', url: 'supabase://artifacts/order-345/preview.png', sha256: 'sha-preview', meta_json: {} },
      { id: 'asset-slicedata', kind: 'slicedata', url: 'supabase://artifacts/order-345/slicedata.json', sha256: 'sha-slicedata', meta_json: {} },
    ],
  })

  const response = await handleStoreRequest({
    supabase: supabase as any,
    auth: { isAdmin: false, user: { id: 'user-1' } },
    orderId,
    body: { status: 'ready', visibility: 'public', name: 'Ready print' },
  })

  assert.equal(response.status, 200)
  assert.equal(supabase.inserts[0].table, 'order_commands')
  assert.equal(supabase.inserts[0].payload.command, 'publishCatalogVersion')
  const productIndex = supabase.inserts.findIndex((row) => row.table === 'products')
  const versionIndex = supabase.inserts.findIndex((row) => row.table === 'product_versions')
  assert.ok(productIndex > 0)
  assert.ok(versionIndex > productIndex)
  assert.equal(supabase.inserts[versionIndex].payload.source_order_id, orderId)
  assert.equal(supabase.inserts[versionIndex].payload.source_artifact_set_hash.length, 64)
})
