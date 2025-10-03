import { NextResponse } from 'next/server'
import { requireAuthContext } from '@/lib/apiAuth'
import { signedUrlWithInfo } from '@/lib/supabaseAdmin'

export const runtime = 'nodejs'

type SignRequest = {
  urls?: string[]
}

export async function POST(req: Request) {
  try {
    try {
      await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }

    const body = (await req.json().catch(() => ({}))) as SignRequest
    const urls = Array.isArray(body?.urls) ? body!.urls!.filter((u): u is string => typeof u === 'string' && u.length > 0) : []
    if (!urls.length) {
      return NextResponse.json({ error: 'urls required' }, { status: 400 })
    }

    const results = [] as { storage_url: string; url: string; expires_at: number | null }[]
    for (const raw of urls) {
      try {
        const signed = await signedUrlWithInfo(raw)
        results.push({ storage_url: raw, url: signed.url, expires_at: signed.expiresAt ?? null })
      } catch (err) {
        results.push({ storage_url: raw, url: raw, expires_at: null })
      }
    }

    return NextResponse.json({ results })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
