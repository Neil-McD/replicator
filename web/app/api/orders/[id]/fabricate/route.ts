import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { LifecycleTransitionError, lifecycleHttpStatus } from '@/lib/lifecycle'
import { handleFabricationLifecycleRequest } from '@/lib/lifecycleRouteHandlers'

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
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    return await handleFabricationLifecycleRequest(supabase, orderId, auth)
  } catch (e: any) {
    if (e instanceof LifecycleTransitionError) {
      return NextResponse.json({ error: e.code }, { status: lifecycleHttpStatus(e) })
    }
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
