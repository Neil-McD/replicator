import { NextResponse } from 'next/server'
import { getT2IProvider } from '@/lib/providers/t2i'
import { requireAuthContext } from '@/lib/apiAuth'

export const runtime = 'nodejs'

// GET /api/debug/t2i/run?prompt=...&n=2
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
    const { searchParams } = new URL(req.url)
    const prompt = String(searchParams.get('prompt') || 'test')
    const n = Math.max(1, Math.min(4, Number(searchParams.get('n') || 2)))
    const provider = getT2IProvider(process.env.T2I_PROVIDER)
    const { imageUrls } = await provider.generateImages({ prompt, n })
    return NextResponse.json({ ok: true, provider: (process.env.T2I_PROVIDER || '').toLowerCase(), imageUrls })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'failed' }, { status: 500 })
  }
}
