import { NextResponse } from 'next/server'
import { requireAuthContext } from '@/lib/apiAuth'

type DeltaDirection = 'up' | 'down' | 'flat'

type SummaryMetric = {
  key: string
  label: string
  format: 'currency' | 'count' | 'percent'
  value: number
  sublabel?: string
  delta?: number
  deltaDirection?: DeltaDirection
  sparkline?: number[]
}

type SummaryResponse = {
  rangeLabel: string
  comparisonLabel: string
  metrics: SummaryMetric[]
  leaderboard: Array<{ product: string; revenueCents: number; orders: number }>
}

function buildMockSummary(range: string): SummaryResponse {
  const label = range === 'today' ? 'Today' : range === '30d' ? 'Last 30 days' : 'Last 7 days'
  const comparison = range === 'today' ? 'vs. yesterday' : 'vs. prior period'
  const multiplier = range === '30d' ? 4 : range === 'today' ? 0.2 : 1
  return {
    rangeLabel: label,
    comparisonLabel: comparison,
    metrics: [
      {
        key: 'net_revenue',
        label: 'Net revenue',
        format: 'currency',
        value: Math.round(184000 * multiplier),
        sublabel: 'Stripe settled $1,480.24',
        delta: 8.4,
        deltaDirection: 'up',
        sparkline: [112, 128, 119, 134, 142, 151, 158].map((v) => v * multiplier),
      },
      {
        key: 'gross_volume',
        label: 'Gross volume',
        format: 'currency',
        value: Math.round(228000 * multiplier),
        sublabel: 'Platform fees and refunds already deducted above',
        delta: 3.1,
        deltaDirection: 'up',
        sparkline: [130, 125, 140, 133, 152, 155, 166].map((v) => v * multiplier),
      },
      {
        key: 'conversion_rate',
        label: 'Channel conversion',
        format: 'percent',
        value: 4.2,
        sublabel: 'Shopify traffic converting at 4.8%',
        delta: 0.6,
        deltaDirection: 'up',
        sparkline: [3.4, 3.6, 3.8, 4.2, 4.1, 4.5, 4.6],
      },
      {
        key: 'refund_rate',
        label: 'Refund rate',
        format: 'percent',
        value: 1.1,
        sublabel: 'Includes TikTok and Etsy partial refunds',
        delta: -0.4,
        deltaDirection: 'down',
        sparkline: [1.6, 1.4, 1.3, 1.2, 1.1, 0.9, 1.0],
      },
    ],
    leaderboard: [
      { product: 'Orbital Desk Rocket', revenueCents: 46000 * multiplier, orders: Math.round(32 * multiplier) },
      { product: 'Flux Cable Nest', revenueCents: 31800 * multiplier, orders: Math.round(27 * multiplier) },
      { product: 'Arcadia Planter Pedestal', revenueCents: 24400 * multiplier, orders: Math.round(18 * multiplier) },
    ],
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
  // TODO: replace mock builder with Supabase + Stripe aggregation
  const payload = buildMockSummary(range)
  return NextResponse.json(payload)
}
