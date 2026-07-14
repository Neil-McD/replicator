import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { LifecycleTransitionError, lifecycleHttpStatus } from '@/lib/lifecycle'
import { handlePrintNowRequest } from '@/lib/lifecycleRouteHandlers'

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
    return await handlePrintNowRequest(supabase, auth, params.id)
  } catch (e: any) {
    if (e instanceof LifecycleTransitionError) {
      return NextResponse.json({ error: e.code }, { status: lifecycleHttpStatus(e) })
    }
    // Swallow detailed server logs; return minimal error
    return NextResponse.json({ error: e.message || 'failed' }, { status: 500 })
  }
}
