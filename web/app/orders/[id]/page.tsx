import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'

async function getOrder(id: string) {
  const supabase = createAdminClient()
  const { data: order } = await supabase.from('orders').select('*').eq('id', id).single()
  const { data: assetsRaw } = await supabase.from('assets').select('*').eq('order_id', id).order('created_at', { ascending: true })
  const assets = await Promise.all((assetsRaw || []).map(async (a) => ({ ...a, signed_url: a.url ? await signedUrlOrDirect(a.url) : null })))
  const { data: events } = await supabase.from('order_events').select('*').eq('order_id', id).order('created_at', { ascending: true })
  return { order, assets, events }
}

function Row({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="text-textMuted">{label}</div>
      <div className="font-mono tabular-nums">{value ?? '—'}</div>
    </div>
  )
}

export default async function OrderDetail({ params }: { params: { id: string } }) {
  const { order, assets, events } = await getOrder(params.id)
  if (!order) {
    return (
      <main className="p-6"><div className="panel p-6">Order not found</div></main>
    )
  }
  const q = order.quote_json || {}
  const preview = assets?.find((a: any) => a.kind === 'slicer_preview_png')?.signed_url
  const stl = assets?.find((a: any) => a.kind === 'repaired_stl')?.signed_url
  const three = assets?.find((a: any) => a.kind === 'three_mf')?.signed_url
  return (
    <main className="p-6 space-y-4">
      <div className="panel p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-textMuted">Order</div>
            <div className="font-mono text-xs">{order.id}</div>
          </div>
          <div className="text-sm">{order.status}</div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <div className="aspect-video w-full overflow-hidden rounded-mdx border border-white/10 bg-black/30">
              {preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="Preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-textMuted">Preview pending</div>
              )}
            </div>
          </div>
          <div className="panel p-3">
            <Row label="Minutes" value={q?.minutes} />
            <Row label="Grams" value={q?.grams} />
            <Row label="Price" value={typeof q?.price_cents === 'number' ? `$${(q.price_cents/100).toFixed(2)}` : '—'} />
            <div className="mt-3 space-y-2 text-sm">
              {stl && <a className="text-teal underline block" href={stl} target="_blank">Download STL</a>}
              {three && <a className="text-teal underline block" href={three} target="_blank">Download 3MF</a>}
            </div>
          </div>
        </div>
      </div>
      <div className="panel p-4">
        <div className="text-xs uppercase tracking-wide text-textMuted mb-2">Timeline</div>
        <ol className="space-y-2">
          {(events || []).map((e: any) => (
            <li key={e.id} className="flex items-center justify-between border-b border-white/5 pb-2">
              <div>
                <div className="text-sm">{e.phase}</div>
                {e.message && <div className="text-xs text-textMuted">{e.message}</div>}
              </div>
              <div className="text-xs text-textMuted font-mono">{new Date(e.created_at).toLocaleString()}</div>
            </li>
          ))}
          {(!events || events.length === 0) && <li className="text-textMuted">No events yet.</li>}
        </ol>
      </div>
    </main>
  )
}
