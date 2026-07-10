import { NextResponse } from 'next/server'

import { createAdminClient } from '@/lib/supabaseAdmin'
import { materializeSelectedImages } from '@/lib/materialize'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    const body = await req.json()
    const orderId: string | undefined = body?.orderId
    const imageIds: string[] | undefined = Array.isArray(body?.imageIds) ? body.imageIds : undefined
    const imageUrls: string[] | undefined = Array.isArray(body?.imageUrls) ? body.imageUrls : undefined
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    // Clear any prior client cancel flag so the worker proceeds with this new action
    try {
      const { data: row } = await supabase.from('orders').select('meta_json').eq('id', orderId).single()
      const prev = (row?.meta_json as any) || {}
      const next = { ...(typeof prev === 'object' && prev ? prev : {}), cancel_requested: false }
      await supabase.from('orders').update({ meta_json: next }).eq('id', orderId)
    } catch {}

    const result = await materializeSelectedImages({
      supabase,
      orderId,
      actor: auth.user?.id || 'user',
      imageIds,
      imageUrls,
      enableQuickMesh: ['1', 'true', 'yes', 'on'].includes(String(process.env.WEB_I23D_FALLBACK || '0').toLowerCase()),
    })

    return NextResponse.json({ ok: true, selected: result.uploaded.length })
  } catch (err: any) {
    const message = err?.message || 'failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
