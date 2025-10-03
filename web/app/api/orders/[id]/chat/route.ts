import { NextResponse } from 'next/server'
import { requireAuthContext } from '@/lib/apiAuth'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { handleOrderAccessError, requireOrderAccess } from '@/lib/orderAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
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

    const { error } = await supabase.from('chat_messages').delete().eq('order_id', params.id)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (error: any) {
    console.error('[api/orders/:id/chat DELETE] error', error?.message)
    return NextResponse.json({ error: error?.message || 'failed' }, { status: 500 })
  }
}
