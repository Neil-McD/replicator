import { createAdminClient } from '@/lib/supabaseAdmin'
import PrintNowButton from '@/components/PrintNowButton'

export const dynamic = 'force-dynamic'

type Row = {
  id: string
  status: string
  created_at: string
  quote_json: any
  has_three_mf?: boolean
}

async function getOrders(): Promise<Row[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('orders')
    .select('id,status,created_at,quote_json')
    .in('status', ['ready_to_pay','paid','needs_review','dispatching','printing'])
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error
  const orders = (data || []) as Row[]
  if (!orders.length) return orders
  // Derive presence of 3MF once, server-side
  const orderIds = orders.map((o) => o.id)
  const { data: assets } = await supabase
    .from('assets')
    .select('order_id,kind')
    .in('order_id', orderIds)
  const has3mf = new Set<string>()
  for (const a of assets || []) {
    if ((a as any)?.kind === 'three_mf') {
      has3mf.add((a as any).order_id as string)
    }
  }
  for (const o of orders) {
    o.has_three_mf = has3mf.has(o.id)
  }
  return orders
}

function fmtPrice(cents?: number) {
  return typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '—'
}

export default async function OperatorPage() {
  const show = process.env.NEXT_PUBLIC_SHOW_OPERATOR
  if (!show) {
    return (
      <main className="p-6">
        <div className="panel p-6">
          <h1 className="text-xl font-semibold">Operator</h1>
          <p className="mt-2 text-textMuted">Set NEXT_PUBLIC_SHOW_OPERATOR=1 to enable.</p>
        </div>
      </main>
    )
  }
  const orders = await getOrders()
  return (
    <main className="p-6">
      <div className="panel p-4">
        <h1 className="text-lg font-semibold">Operator Queue</h1>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-textMuted">
              <tr>
                <th className="py-2 pr-4">Order</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Created</th>
                <th className="py-2 pr-4">Quote</th>
                <th className="py-2 pr-4">Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const q = o.quote_json || {}
                const quote = `${q?.minutes ?? '—'} min · ${q?.grams ?? '—'} g · ${fmtPrice(q?.price_cents)}`
                return (
                  <tr key={o.id} className="border-t border-white/5">
                    <td className="py-2 pr-4 font-mono text-xs tabular-nums">{o.id.slice(0,8)}</td>
                    <td className="py-2 pr-4">{o.status}</td>
                    <td className="py-2 pr-4 text-textMuted font-mono text-xs">{new Date(o.created_at).toLocaleString()}</td>
                    <td className="py-2 pr-4">{quote}</td>
                    <td className="py-2 pr-4">
                      {(o.status === 'paid' || o.status === 'ready_to_pay') && o.has_three_mf ? (
                        <PrintNowButton orderId={o.id} />
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}
