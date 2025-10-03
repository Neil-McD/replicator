import { NextResponse } from 'next/server'
import { requireAuthContext } from '@/lib/apiAuth'

type TimeseriesPoint = {
  date: string
  grossCents: number
  netCents: number
  feeCents: number
  orders: number
}

type TimeseriesResponse = {
  rangeLabel: string
  points: TimeseriesPoint[]
}

function buildMockSeries(range: string): TimeseriesResponse {
  const base = [
    { gross: 42000, net: 34000, fee: 8000, orders: 18 },
    { gross: 46000, net: 37200, fee: 8800, orders: 22 },
    { gross: 39500, net: 31800, fee: 7700, orders: 19 },
    { gross: 51200, net: 41200, fee: 10000, orders: 24 },
    { gross: 53800, net: 43200, fee: 10600, orders: 26 },
    { gross: 56200, net: 44800, fee: 11400, orders: 29 },
    { gross: 58500, net: 46800, fee: 11700, orders: 31 },
  ]
  const multiplier = range === '30d' ? 1.4 : range === 'today' ? 0.35 : 1

  const today = new Date()
  const points = base.map((entry, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() - (base.length - 1 - index))
    return {
      date: date.toISOString(),
      grossCents: Math.round(entry.gross * multiplier),
      netCents: Math.round(entry.net * multiplier),
      feeCents: Math.round(entry.fee * multiplier),
      orders: Math.max(1, Math.round(entry.orders * multiplier)),
    }
  })

  return {
    rangeLabel: range === 'today' ? 'Hourly' : 'Last 7 days',
    points,
  }
}

export async function GET(req: Request) {
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
  const url = new URL(req.url)
  const range = url.searchParams.get('range') ?? '7d'
  const payload = buildMockSeries(range)
  return NextResponse.json(payload)
}
