import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { handleStoreRequest } from '@/lib/storeRequest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const orderId = params.id
  try {
    const auth = await requireAuthContext(req)
    const supabase = createAdminClient()
    const body = await req.json().catch(() => ({}))
    return await handleStoreRequest({ supabase, auth, orderId, body })
  } catch (error: any) {
    console.error('[orders/store] error', error?.message)
    return NextResponse.json({ error: error?.message || 'failed' }, { status: 500 })
  }
}
