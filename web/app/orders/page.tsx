"use client"
import { useEffect, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabaseClient'

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data: { user } } = await supabaseBrowser.auth.getUser()
      if (!user) { setReady(true); setOrders([]); return }
      const { data, error } = await supabaseBrowser
        .from('orders')
        .select('id,status,created_at,quote_json')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)
      if (!cancelled) {
        setOrders(error ? [] : (data || []))
        setReady(true)
      }
    }
    load()
    const { data: sub } = supabaseBrowser.auth.onAuthStateChange(() => load())
    return () => { cancelled = true; sub.subscription.unsubscribe() }
  }, [])

  return (
    <main className="p-6">
      <div className="panel p-6">
        <h1 className="text-xl font-semibold">Orders</h1>
        {!ready && <div className="mt-2 text-textMuted">Loading…</div>}
        {ready && (
          <div className="mt-4 space-y-2">
            {orders.map((o) => (
              <a key={o.id} href={`/orders/${o.id}`} className="block rounded-mdx border border-white/10 p-3 hover:bg-white/5">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-xs text-textMuted">{o.id}</div>
                  <div className="text-sm">{o.status}</div>
                </div>
                <div className="mt-1 text-xs text-textMuted">{new Date(o.created_at).toLocaleString()}</div>
              </a>
            ))}
            {orders.length === 0 && (
              <div className="text-textMuted">No orders yet. Sign in and create one.</div>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
