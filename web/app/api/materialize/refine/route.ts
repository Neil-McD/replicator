import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(_req: Request) {
  return NextResponse.json({ error: 'refine_disabled', message: 'High fidelity mesh refinement runs automatically now.' }, { status: 410 })
}
