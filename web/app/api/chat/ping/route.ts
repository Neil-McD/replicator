import { NextResponse } from 'next/server'
import { getOpenAI, DEFAULT_OPENAI_MODEL } from '@/lib/llm'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const openai = getOpenAI()
    const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL || 'gpt-5-mini-2025-08-07'
    const r = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are a health check. Reply with one word: pong.' },
        { role: 'user', content: 'ping' },
      ],
    })
    const text = r.choices?.[0]?.message?.content?.toString().trim() || ''
    return NextResponse.json({ ok: true, model, reply: text })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'openai_error' }, { status: 500 })
  }
}
