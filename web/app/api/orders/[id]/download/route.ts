import { NextResponse } from 'next/server'
import { createAdminClient, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type AdminClient = ReturnType<typeof createAdminClient>

type FindAssetOptions = {
  targetMm?: number | null
  toleranceMm?: number
  skipAssetId?: string | null
}

async function findAssetSignedUrl(
  supabase: AdminClient,
  orderId: string,
  kinds: string[],
  ttl = 3600,
  options: FindAssetOptions = {}
): Promise<string | null> {
  const { targetMm, toleranceMm, skipAssetId } = options
  const hasTarget = typeof targetMm === 'number' && Number.isFinite(targetMm)
  const tolerance = hasTarget ? Math.max(0.1, Number(toleranceMm) || 0.75) : 0
  const { data: assets } = await supabase
    .from('assets')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .limit(300)
  const list = Array.isArray(assets) ? assets : []
  for (let i = list.length - 1; i >= 0; i--) {
    const asset = list[i]
    const kind = String(asset?.kind || '')
    if (!kinds.includes(kind)) continue
    if (skipAssetId && String(asset?.id || '') === skipAssetId) continue
    if (hasTarget) {
      const meta = asset?.meta_json || {}
      const stored = Number(meta?.target_max_dim_mm ?? meta?.target_max_dim ?? meta?.target)
      if (!Number.isFinite(stored)) continue
      if (Math.abs(stored - (targetMm as number)) > tolerance) continue
    }
    if (!asset?.url) continue
    const signed = await signedUrlOrDirect(asset.url as string, ttl)
    if (signed) return signed
  }
  return null
}

// GET /api/orders/:id/download?kind=repaired_sized_stl&filename=print-ready.stl&wait=1
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { searchParams } = new URL(req.url)
  const orderId = params.id
  let auth
  try {
    auth = await requireAuthContext(req)
  } catch (error: any) {
    const status = Number(error?.statusCode) || 401
    return NextResponse.json({ error: 'not_authenticated' }, { status })
  }
  const supabase = createAdminClient()
  const { data: orderRow, error: orderErr } = await supabase
    .from('orders')
    .select('id,user_id')
    .eq('id', orderId)
    .single()
  if (orderErr || !orderRow) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (!auth.isAdmin && orderRow.user_id && orderRow.user_id !== auth.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const primary = (searchParams.get('kind') || 'repaired_sized_stl').trim()
  const filename = (searchParams.get('filename') || '').trim() || (primary.includes('3mf') ? 'model.3mf' : 'model.stl')
  const wait = (searchParams.get('wait') || '1').trim().toLowerCase() !== '0'
  const ttl = Math.max(60, Math.min(6 * 3600, Number(searchParams.get('ttl') || 900)))
  const wantsJson = searchParams.get('format') === 'json' || ((req.headers.get('accept') || '').includes('application/json'))
  const targetMmRaw = Number(searchParams.get('target_mm'))
  const hasTarget = Number.isFinite(targetMmRaw)
  const tolRaw = Number(searchParams.get('target_tol_mm'))
  const targetTol = hasTarget ? Math.max(0.1, Math.min(10, Number.isFinite(tolRaw) ? tolRaw : 0.75)) : undefined
  const pollIntervalParam = Number(searchParams.get('poll_interval_ms'))
  const pollIntervalMs = Number.isFinite(pollIntervalParam) ? Math.max(500, Math.min(5000, pollIntervalParam)) : 1200
  const maxWaitParam = Number(searchParams.get('max_wait_ms'))
  const maxWaitMs = Number.isFinite(maxWaitParam) ? Math.max(pollIntervalMs, Math.min(300000, maxWaitParam)) : 60000
  const skipAssetId = (searchParams.get('skip_asset_id') || '').trim() || null
  const kinds = [primary, !hasTarget && primary === 'repaired_sized_stl' ? 'repaired_stl' : '']
    .filter(Boolean) as string[]
  // First, try immediate lookup
  let signed = await findAssetSignedUrl(supabase, orderId, kinds, ttl, {
    targetMm: hasTarget ? targetMmRaw : undefined,
    toleranceMm: targetTol,
    skipAssetId,
  })
  if (signed) {
    try {
      const u = new URL(signed)
      if (!u.searchParams.has('download')) u.searchParams.set('download', filename)
      signed = u.toString()
    } catch {}
    if (wantsJson) {
      return NextResponse.json({ url: signed })
    }
    return NextResponse.redirect(signed, 302)
  }
  if (!wait) return NextResponse.json({ error: 'not_ready' }, { status: 202 })

  // Poll up to ~60s for the asset to appear
  const start = Date.now()
  const deadline = start + maxWaitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs))
    signed = await findAssetSignedUrl(supabase, orderId, kinds, ttl, {
      targetMm: hasTarget ? targetMmRaw : undefined,
      toleranceMm: targetTol,
      skipAssetId,
    })
    if (signed) {
      try {
        const u = new URL(signed)
        if (!u.searchParams.has('download')) u.searchParams.set('download', filename)
        signed = u.toString()
      } catch {}
      if (wantsJson) {
        return NextResponse.json({ url: signed })
      }
      return NextResponse.redirect(signed, 302)
    }
  }
  // Graceful fallback page instructing the user to retry
  const retryAfterSeconds = Math.max(1, Math.round(pollIntervalMs / 1000))
  if (wantsJson) {
    return NextResponse.json(
      { error: 'timeout', retry_after: retryAfterSeconds },
      { status: 202, headers: { 'cache-control': 'no-store', 'retry-after': String(retryAfterSeconds) } },
    )
  }
  const html = `<!doctype html><meta charset="utf-8" />
  <title>Preparing download…</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>body{background:#0b0b0c;color:#d9e1e8;font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";padding:24px} .panel{background:#0f1012;border:1px solid #1b1d22;border-radius:8px;padding:18px;max-width:560px} a{color:#2ee6d6}</style>
  <div class="panel">
    <h1 style="margin:0 0 8px;font-size:16px">Still preparing your STL…</h1>
    <p style="margin:0 0 12px;font-size:14px">This can take a moment. You can <a href="/api/orders/${orderId}/download?kind=${encodeURIComponent(primary)}&filename=${encodeURIComponent(filename)}&wait=1">retry</a> or close this tab and try again from the app.</p>
  </div>`
  return new NextResponse(html, {
    status: 202,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(retryAfterSeconds),
    },
  })
}
