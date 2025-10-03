import { NextResponse } from 'next/server'
import { requireAuthContext } from '@/lib/apiAuth'

export const runtime = 'nodejs'

// GET /api/debug/t2i
// Returns the effective T2I provider env and the resolved FAL endpoint the server will call.
export async function GET(req: Request) {
  try {
    let auth
    try {
      auth = await requireAuthContext(req)
    } catch (error: any) {
      const status = Number(error?.statusCode) || 401
      return NextResponse.json({ error: 'not_authenticated' }, { status })
    }
    if (!auth.isAdmin) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const provider = (process.env.T2I_PROVIDER || '').trim()
    const base = ((process.env.FAL_BASE_URL || 'https://fal.run').trim()).replace(/\/$/, '')
    const rawId = (process.env.FAL_MODEL_ID || '').trim()
    const clean = (v: string): string => {
      // Align with provider resolution in web/lib/providers/t2i.ts (no /generate suffix)
      let s = (v || '').trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '')
      s = s.replace(/^\/+/, '')
      s = s.replace(/\/(generate|invoke|run|call)\/?$/i, '')
      if (!s || s === 'generate' || s === '/generate') return 'fal-ai/nano-banana'
      if (s === 'nano-banana/generate' || s === '/nano-banana/generate') return 'fal-ai/nano-banana'
      if (s === 'fal-ai/nano-banana' || s === 'nano-banana') return 'fal-ai/nano-banana'
      return s
    }
    const fallback = provider.toLowerCase().includes('nano') ? 'fal-ai/nano-banana' : 'fal-ai/flux/dev'
    const modelId = clean(rawId) || fallback
    const endpoint = `${base}/${modelId}`
    return NextResponse.json({ provider, FAL_BASE_URL: base, FAL_MODEL_ID_raw: rawId, FAL_MODEL_ID_resolved: modelId, endpoint })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 })
  }
}
