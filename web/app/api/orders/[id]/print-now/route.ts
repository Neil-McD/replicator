import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { LifecycleTransitionError, lifecycleHttpStatus, requestDispatch } from '@/lib/lifecycle'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    // Operator gating: only admin/operator can dispatch prints (Phase-1)
    if (!(auth.isAdmin || auth.isOperator)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    // Optional: ensure order exists for better error messages
    try {
      const { error } = await supabase.from('orders').select('id').eq('id', params.id).single()
      if (error) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    } catch {}
    const { data: asset } = await supabase.from('assets').select('*').eq('order_id', params.id).eq('kind', 'three_mf').order('created_at', { ascending: false }).limit(1).single()
    if (!asset) return NextResponse.json({ error: '3MF not found' }, { status: 404 })
    const signed = await signedUrlOrDirect(asset.url)
    const link = `bambu-connect://import-file?file=${encodeURIComponent(signed)}`
    const transition = await requestDispatch(supabase, params.id, {
      actor: 'operator',
      idempotencyKey: `print-now:${asset.id}`,
      eventMessage: 'Operator requested printer dispatch',
      eventMeta: { asset_id: asset.id },
      patch: { worker_id: null, locked_at: null },
    })
    return NextResponse.json({ link, status: transition.newStatus, reused: transition.reused })
  } catch (e: any) {
    if (e instanceof LifecycleTransitionError) {
      return NextResponse.json({ error: e.code }, { status: lifecycleHttpStatus(e) })
    }
    // Swallow detailed server logs; return minimal error
    return NextResponse.json({ error: e.message || 'failed' }, { status: 500 })
  }
}
