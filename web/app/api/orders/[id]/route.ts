import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/orders/:id
// Returns order row and assets with signed URLs for client polling.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
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
      order = await requireOrderAccess(supabase, params.id, auth, '*')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }
    const { data: assetsRaw, error: assetsErr } = await supabase
      .from('assets')
      .select('*')
      .eq('order_id', params.id)
      .order('created_at', { ascending: true })
    if (assetsErr) throw assetsErr
    const assets = await Promise.all(
      (assetsRaw || []).map(async (a: any) => ({ ...a, signed_url: a.url ? await signedUrlOrDirect(a.url) : null }))
    )
    const { data: jobsRaw, error: jobsErr } = await supabase
      .from('export_jobs')
      .select('id,job_type,status,quote_json,target_max_dim_mm,target_tolerance_mm,asset_id,transform_asset_id,error_message,meta_json,created_at,updated_at,started_at,completed_at')
      .eq('order_id', params.id)
      .order('created_at', { ascending: true })
    if (jobsErr) throw jobsErr
    return NextResponse.json({ order, assets, exportJobs: jobsRaw || [] })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}

// PATCH /api/orders/:id
// Body: { prompt_text?: string }
// Renames a project (order) title/Prompt. Auth + RLS enforced via order access check.
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
    const raw = (body?.prompt_text ?? body?.name ?? '').toString()
    const next = raw.trim().slice(0, 200)
    const { error } = await supabase
      .from('orders')
      .update({ prompt_text: next })
      .eq('id', params.id)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}

// DELETE /api/orders/:id
// Deletes a project (order). Assets and child rows should follow FK cascade.
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
    const { error } = await supabase
      .from('orders')
      .delete()
      .eq('id', params.id)
    if (error) {
      // Map common FK violation to a user-friendly 409 so client can surface it
      const code = (error as any)?.code || (error as any)?.details
      if (code === '23503') {
        return NextResponse.json({ error: 'has_children' }, { status: 409 })
      }
      throw error
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
