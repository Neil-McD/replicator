import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const orderId = params.id
    if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const supabase = createAdminClient()
    let order: any
    try {
      order = await requireOrderAccess(supabase, orderId, auth, 'id,status,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    const status = typeof order.status === 'string' ? order.status : null
    const terminalStates = new Set(['repairing','slicing','stl_ready','ready_to_pay','paid','dispatching','printing'])
    if (status === 'fabrication_requested') {
      return NextResponse.json({ ok: true, status })
    }
    if (status && terminalStates.has(status)) {
      return NextResponse.json({ ok: true, status })
    }
    await supabase.from('orders').update({ status: 'fabrication_requested', worker_id: null, locked_at: null }).eq('id', orderId)
    await supabase.from('order_events').insert({ order_id: orderId, phase: 'fabrication_requested', message: 'User requested fabrication' })
    try {
      await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: 'On it — stabilizing the mesh for a print-ready quote.' } })
    } catch { /* no-op */ }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
