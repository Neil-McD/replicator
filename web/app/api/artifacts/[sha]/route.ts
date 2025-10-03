import { NextResponse } from 'next/server'
import { createAdminClient, parseSupabaseUrl } from '@/lib/supabaseAdmin'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/artifacts/:sha[?at=<token>]
// Streams an artifact by its content hash (sha256) with strong caching headers.
// Auth: same as other API routes; accepts Bearer header or `at` query param for loader fetches.
export async function GET(req: Request, { params }: { params: { sha: string } }) {
  const sha = (params?.sha || '').toLowerCase()
  if (!sha || sha.length < 16) {
    return NextResponse.json({ error: 'bad_sha' }, { status: 400 })
  }
  try {
    // Allow passing token via `at` query param for loaders that cannot set headers easily
    const url = new URL(req.url)
    let auth
    try {
      const tokenFromQuery = url.searchParams.get('at')
      if (tokenFromQuery) {
        // Construct a synthetic Authorization header for requireAuthContext
        const headers = new Headers(req.headers)
        headers.set('Authorization', `Bearer ${tokenFromQuery}`)
        const shadowReq = new Request(req, { headers })
        auth = await requireAuthContext(shadowReq)
      } else {
        auth = await requireAuthContext(req)
      }
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }

    const supabase = createAdminClient()
    // Resolve asset by sha and enforce order access
    const { data: asset, error } = await supabase
      .from('assets')
      .select('id,order_id,url,meta_json,sha256')
      .eq('sha256', sha)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    if (!asset) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    try {
      await requireOrderAccess(supabase, asset.order_id as string, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    const parsed = parseSupabaseUrl(asset.url as string)
    let blob: any = null
    let pathLower = ''
    if (parsed) {
      // Stream via service-role download
      const dl = await supabase.storage.from(parsed.bucket).download(parsed.path)
      if (dl?.error || !dl?.data) {
        return NextResponse.json({ error: 'storage_download_failed' }, { status: 502 })
      }
      blob = dl.data
      pathLower = (parsed.path || '').toLowerCase()
    } else {
      // Fallback: if URL is a direct HTTP(s) link, stream it via node fetch
      try {
        const r = await fetch(asset.url as string)
        if (!r.ok || !r.body) return NextResponse.json({ error: 'bad_storage_url' }, { status: 500 })
        // Convert ReadableStream<Uint8Array> to a blob-like object by buffering
        const ab = await r.arrayBuffer()
        blob = new Blob([ab])
        try { const u = new URL(asset.url as string); pathLower = u.pathname.toLowerCase() } catch {}
      } catch {
        return NextResponse.json({ error: 'bad_storage_url' }, { status: 500 })
      }
    }

    const headers: Record<string, string> = {
      'Cache-Control': 'public, max-age=31536000, immutable, stale-while-revalidate=86400',
      'ETag': sha,
      'X-Content-Type-Options': 'nosniff',
    }
    // Guess content-type from path or meta_json when available
    try {
      const p = pathLower
      let ct = ''
      if (p.endsWith('.stl')) ct = 'model/stl'
      else if (p.endsWith('.glb')) ct = 'model/gltf-binary'
      else if (p.endsWith('.3mf')) ct = 'model/3mf'
      else if (p.endsWith('.png')) ct = 'image/png'
      else if (p.endsWith('.obj')) ct = 'model/obj'
      if (!ct) {
        const meta = (asset.meta_json as any) || null
        const mct = typeof meta?.content_type === 'string' ? meta.content_type : null
        if (mct) ct = mct
      }
      if (ct) headers['Content-Type'] = ct
    } catch {}
    const size = Number((blob as any)?.size || 0)
    if (Number.isFinite(size) && size > 0) headers['Content-Length'] = String(size)

    // Conditional GET
    const inm = req.headers.get('if-none-match')
    if (inm && inm === sha) {
      return new NextResponse(null, { status: 304, headers })
    }

    return new NextResponse(blob.stream(), { status: 200, headers })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}

// HEAD /api/artifacts/:sha — conditional check without body
export async function HEAD(req: Request, ctx: { params: { sha: string } }) {
  const res = await GET(req, ctx)
  // If 200 with body, convert to 200 without body but preserve headers
  if (!res.body && (res.status === 304 || res.status >= 400)) return res
  const headers = new Headers(res.headers)
  return new NextResponse(null, { status: 200, headers })
}
