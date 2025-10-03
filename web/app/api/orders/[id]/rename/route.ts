import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH /api/orders/:id/rename
// Body: { title: string }
// Updates orders.title. Auth via order access; RLS on orders table applies.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    try {
      await requireOrderAccess(supabase, params.id, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    const body = await req.json().catch(() => ({})) as any
    const raw = (body?.title ?? '').toString()
    const title = raw.trim().slice(0, 200)
    if (!title) return NextResponse.json({ error: 'invalid_title' }, { status: 400 })
    const { data, error } = await supabase
      .from('orders')
      .update({ title })
      .eq('id', params.id)
      .select('id,title,updated_at')
      .single()
    if (error) throw error
    return NextResponse.json({ id: data.id, title: data.title, updated_at: data.updated_at })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}

