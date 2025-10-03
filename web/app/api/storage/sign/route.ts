import { NextResponse } from 'next/server'
import { requireAuthContext } from '@/lib/apiAuth'
import { requireOrderAccess, handleOrderAccessError } from '@/lib/orderAccess'
import { createAdminClient, normalizeSupabaseUrl, parseSupabaseUrl, signedUrlWithInfo } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'

type ImageInput = {
  id?: string
  url?: string | null
}

type SignRequest = {
  orderId?: string
  images?: ImageInput[]
  urls?: string[]
}

type SignResult = {
  id?: string
  url: string | null
  storage_url: string | null
  expires_at: number | null
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as SignRequest
    const orderId = typeof body.orderId === 'string' ? body.orderId : undefined
    const imageInputs = Array.isArray(body.images) ? body.images.filter(Boolean) : []
    const fallbackUrls = Array.isArray(body.urls) ? body.urls.filter((u): u is string => typeof u === 'string' && u.length > 0) : []

    if (!orderId) {
      return NextResponse.json({ error: 'orderId required' }, { status: 400 })
    }

    const auth = await requireAuthContext(req).catch((error: any) => {
      const status = Number(error?.statusCode) || 401
      throw NextResponse.json({ error: 'not_authenticated' }, { status })
    })

    const supabase = createAdminClient()
    try {
      await requireOrderAccess(supabase, orderId, auth, 'id,user_id')
    } catch (error: any) {
      const { status, body } = handleOrderAccessError(error)
      return NextResponse.json(body, { status })
    }

    const imageIds = imageInputs.map((img) => img.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
    const imageMap = new Map<string, { url: string }>()
    if (imageIds.length) {
      const { data } = await supabase
        .from('images')
        .select('id,url')
        .eq('order_id', orderId)
        .in('id', imageIds)
      for (const row of data || []) {
        if (row?.id && row?.url) {
          imageMap.set(row.id, { url: row.url })
        }
      }
    }

    const targets: { id?: string; url: string | null }[] = []
    for (const item of imageInputs) {
      const mapped = (item?.id && imageMap.get(item.id)?.url) || item?.url || null
      const canonical = normalizeSupabaseUrl(mapped ?? undefined) || mapped
      targets.push({ id: item?.id, url: canonical })
    }
    for (const url of fallbackUrls) {
      const canonical = normalizeSupabaseUrl(url) || url
      targets.push({ url: canonical })
    }

    const results: SignResult[] = []
    for (const target of targets) {
      const original = target.url
      if (!original) {
        results.push({ id: target.id, url: null, storage_url: null, expires_at: null })
        continue
      }
      const parsed = parseSupabaseUrl(original)
      if (!parsed) {
        // Non-supabase URL cannot be re-signed; return as-is so the client can decide next steps
        results.push({ id: target.id, url: original, storage_url: original, expires_at: null })
        continue
      }
      try {
        const signed = await signedUrlWithInfo(original)
        results.push({ id: target.id, url: signed.url, storage_url: original, expires_at: signed.expiresAt ?? null })
      } catch (err) {
        console.warn('[storage/sign] failed to sign', parsed.bucket, parsed.path, err)
        results.push({ id: target.id, url: null, storage_url: original, expires_at: null })
      }
    }

    return NextResponse.json({ results })
  } catch (e: any) {
    if (e instanceof Response) return e
    console.error('[storage/sign] error', e)
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
