import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabaseAdmin'
import { ensureOrgForUser, isMissingColumnError } from '@/lib/orgs'
import { requireAuthContext } from '@/lib/apiAuth'

export async function POST(req: Request) {
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    const body = await req.json().catch(() => ({})) as any
    const prompt = (body.prompt_text || '').toString()
    const userId = auth.user.id
    console.log('[api/orders POST] body keys:', Object.keys(body || {}), 'userId?', !!userId, 'prompt_len', prompt.length)
    if (!userId) return NextResponse.json({ error: 'not_authenticated' }, { status: 401 })
    // Simple moderation guard
    const BLOCKLIST = ['weapon','gun','knife','drone','illegal','ip','copyright','trademark','nazi','bomb']
    const flagged = prompt.toLowerCase()
    const needsReview = BLOCKLIST.some(w => flagged.includes(w))
    const supabase = createAdminClient()
    const orgId = await ensureOrgForUser(supabase, userId)
    let insertResult = await supabase
      .from('orders')
      .insert({
        org_id: orgId,
        user_id: userId,
        prompt_text: prompt,
        status: needsReview ? 'needs_review' : 'new',
      })
      .select('id')
      .single()

    if (insertResult.error && isMissingColumnError(insertResult.error, 'orders', 'org_id')) {
      console.warn('[api/orders POST] orders.org_id column missing; retrying without org support')
      insertResult = await supabase
        .from('orders')
        .insert({
          user_id: userId,
          prompt_text: prompt,
          status: needsReview ? 'needs_review' : 'new',
        })
        .select('id')
        .single()
    }

    if (insertResult.error) throw insertResult.error
    const data = insertResult.data
    if (needsReview) {
      await supabase.from('order_events').insert({ order_id: data.id, phase: 'needs_review', message: 'Blocked by moderation guard' })
    }
    console.log('[api/orders POST] created order', data.id)
    return NextResponse.json({ order_id: data.id })
  } catch (e: any) {
    console.error('[api/orders POST] error:', e?.message)
    return NextResponse.json({ error: e.message || 'failed' }, { status: 500 })
  }
}

export async function GET() {
  console.log('[api/orders GET] ping')
  return NextResponse.json({ ok: true })
}
