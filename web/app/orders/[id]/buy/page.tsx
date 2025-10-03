import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import Link from 'next/link'
import BuyClient from './purchase-client'

export const runtime = 'nodejs'

async function getInitial(id: string) {
  const supabase = createAdminClient()
  const { data: order } = await supabase
    .from('orders')
    .select('id,status,quote_json,created_at')
    .eq('id', id)
    .single()
  const { data: assetsRaw } = await supabase
    .from('assets')
    .select('id,kind,url,created_at')
    .eq('order_id', id)
    .order('created_at', { ascending: true })
  const preview = (assetsRaw || []).filter((a: any) => a.kind === 'slicer_preview_png').pop()
  const three = (assetsRaw || []).filter((a: any) => a.kind === 'three_mf').pop()
  const stl = (assetsRaw || []).filter((a: any) => a.kind === 'repaired_stl' || a.kind === 'repaired_sized_stl').pop()
  const signedPreview = preview ? await signedUrlOrDirect(preview.url) : null
  const signedThree = three ? await signedUrlOrDirect(three.url) : null
  const signedStl = stl ? await signedUrlOrDirect(stl.url) : null
  return {
    order: order || null,
    assets: {
      previewUrl: signedPreview,
      threeMfUrl: signedThree,
      stlUrl: signedStl,
    },
  }
}

export default async function PurchasePage({ params }: { params: { id: string } }) {
  const supabase = createAdminClient()
  // Simple auth gate; render a minimal fallback if unauthenticated
  let authed = true
  try { await requireAuthContext({} as any) } catch { authed = false }
  const { order, assets } = await getInitial(params.id)
  if (!order) {
    return (
      <main className="p-6">
        <div className="panel p-6">Order not found. <Link className="text-teal underline" href="/orders">Back</Link></div>
      </main>
    )
  }
  return (
    <main className="p-6">
      <div className="panel p-4 max-w-2xl mx-auto">
        <div className="flex items-start gap-4">
          <div className="w-1/2">
            <div className="aspect-square w-full overflow-hidden rounded-mdx border border-white/10 bg-black/30">
              {assets.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assets.previewUrl} alt="Preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-textMuted">Preview pending</div>
              )}
            </div>
            <div className="mt-3 text-xs text-textMuted">
              Order <span className="font-mono">{order.id}</span>
            </div>
          </div>
          <div className="w-1/2">
            <BuyClient orderId={order.id} initialStatus={order.status} initialQuote={order.quote_json || null} />
          </div>
        </div>
      </div>
    </main>
  )
}

