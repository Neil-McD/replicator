"use client"

import { useEffect, useMemo, useState } from 'react'
import LeftRail from '@/components/LeftRail'
import SalesKpiCard from '@/components/SalesKpiCard'

const DATE_PRESETS = [
  { label: 'Today', value: 'today' },
  { label: '7 days', value: '7d' },
  { label: '30 days', value: '30d' },
]

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

type ChannelStatus = 'connected' | 'syncing' | 'error' | 'disconnected'

type ChannelResponse = {
  id: string
  name: string
  kind: string
  status: ChannelStatus
  lastSync: string
  totalSalesCents: number
  pendingOrders: number
  avatar: string
  link?: string
}

type TimelineEvent = {
  id: string
  title: string
  time: string
  type: 'payout' | 'sync' | 'alert' | 'note'
  description: string
}

const FEATURE_CALLOUTS = [
  {
    title: 'Realtime payout tracking',
    body: 'Stripe webhook ingestion mirrors balances and upcoming payouts so you always know when cash clears.'
  },
  {
    title: 'Channel health diagnostics',
    body: 'We surface sync failures, listing mismatches, and stock drift before marketplaces penalize your storefront.'
  },
  {
    title: 'Automations & bulk sync',
    body: 'Toggle auto-publish, schedule promo pricing, or resync entire catalogs with one click.'
  },
]

const TIMELINE_FEATURES: TimelineEvent[] = [
  {
    id: 'evt-001',
    title: 'Stripe payout initiated',
    time: '2:12 PM',
    type: 'payout',
    description: 'Stripe transferring $1,480.24 to your bank account • arrives in 2 business days.'
  },
  {
    id: 'evt-002',
    title: 'Shopify sync complete',
    time: '1:47 PM',
    type: 'sync',
    description: '12 products refreshed • 3 pricing updates • 0 errors.'
  },
  {
    id: 'evt-003',
    title: 'Etsy order needs review',
    time: '1:08 PM',
    type: 'alert',
    description: 'Buyer requested PLA silk variant outside supported materials. Route to operator chat?'
  },
  {
    id: 'evt-004',
    title: 'Automation suggestion',
    time: '12:55 PM',
    type: 'note',
    description: 'Enable auto-publish for TikTok Shop to keep viral clips in stock while campaigns run.'
  },
]

function formatCurrency(cents: number): string {
  const dollars = cents / 100
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function formatValue(metric: SummaryMetric): string {
  if (metric.format === 'currency') return formatCurrency(metric.value)
  if (metric.format === 'percent') return `${metric.value.toFixed(1)}%`
  return metric.value.toLocaleString('en-US')
}

function formatIsoDate(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type RevenueChartProps = {
  points: TimeseriesPoint[]
}

function RevenueChart({ points }: RevenueChartProps) {
  if (!points || points.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center rounded-xl border border-white/10 bg-black/40 text-sm text-textMuted">
        Connect a store to see revenue trendlines.
      </div>
    )
  }

  const width = 720
  const height = 220
  const padding = 32

  const grossValues = points.map((p) => p.grossCents / 100)
  const netValues = points.map((p) => p.netCents / 100)
  const orderValues = points.map((p) => p.orders)
  const maxRevenue = Math.max(...grossValues, 0)
  const maxOrders = Math.max(...orderValues, 1)
  const xStep = (width - padding * 2) / Math.max(points.length - 1, 1)

  const toX = (index: number) => padding + index * xStep
  const toY = (value: number) => {
    if (maxRevenue === 0) return height - padding
    return padding + (height - padding * 2) * (1 - value / maxRevenue)
  }
  const toOrderY = (value: number) => {
    return padding + (height - padding * 2) * (1 - value / maxOrders)
  }

  const buildPath = (values: number[]) => {
    return values
      .map((value, index) => `${index === 0 ? 'M' : 'L'} ${toX(index).toFixed(2)} ${toY(value).toFixed(2)}`)
      .join(' ')
  }

  const grossPath = buildPath(grossValues)
  const netPath = buildPath(netValues)
  const orderPoints = orderValues.map((value, index) => ({ x: toX(index), y: toOrderY(value) }))

  const yTicks = 4
  const gridLines = Array.from({ length: yTicks + 1 }).map((_, idx) => {
    const value = (maxRevenue / yTicks) * idx
    const y = toY(value)
    return { value, y }
  })

  return (
    <div className="rounded-2xl border border-white/10 bg-black/40 p-5 shadow-[0_24px_60px_-45px_rgba(0,0,0,0.9)]">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.28em] text-teal/70">Revenue</div>
          <h3 className="text-lg font-semibold text-white">Gross vs net revenue</h3>
        </div>
        <div className="flex gap-4 text-xs text-textMuted">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-teal" /> Net revenue
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-white/80" /> Gross revenue
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-warning" /> Orders
          </span>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <svg width={width} height={height} className="min-w-full">
          <defs>
            <linearGradient id="netFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(46,230,214,0.36)" />
              <stop offset="100%" stopColor="rgba(46,230,214,0.05)" />
            </linearGradient>
          </defs>
          {gridLines.map((line) => (
            <g key={line.value}>
              <line
                x1={padding}
                x2={width - padding}
                y1={line.y}
                y2={line.y}
                stroke="rgba(255,255,255,0.08)"
                strokeDasharray="4 6"
              />
              <text x={padding - 10} y={line.y + 4} fontSize={10} fill="rgba(255,255,255,0.35)" textAnchor="end">
                {formatCurrency(line.value * 100)}
              </text>
            </g>
          ))}

          <path
            d={`${grossPath} L ${toX(points.length - 1)} ${height - padding} L ${padding} ${height - padding} Z`}
            fill="rgba(255,255,255,0.06)"
            stroke="none"
          />
          <path d={grossPath} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" />

          <path
            d={`${netPath} L ${toX(points.length - 1)} ${height - padding} L ${padding} ${height - padding} Z`}
            fill="url(#netFill)"
            stroke="none"
          />
          <path d={netPath} fill="none" stroke="rgba(46,230,214,0.9)" strokeWidth={2.5}
            strokeLinecap="round" strokeLinejoin="round" />

          {orderPoints.map((point, index) => (
            <g key={`orders-${index}`}>
              <circle cx={point.x} cy={point.y} r={4} fill="rgba(234,181,80,0.9)" />
            </g>
          ))}

          {points.map((point, index) => (
            <text
              key={point.date}
              x={toX(index)}
              y={height - padding + 16}
              fontSize={10}
              fill="rgba(255,255,255,0.45)"
              textAnchor="middle"
            >
              {formatIsoDate(point.date)}
            </text>
          ))}
        </svg>
      </div>
    </div>
  )
}

function ChannelStatusBadge({ status }: { status: ChannelStatus }) {
  const map: Record<ChannelStatus, { label: string; className: string }> = {
    connected: { label: 'Connected', className: 'bg-teal/15 text-teal' },
    syncing: { label: 'Syncing', className: 'bg-warning/15 text-warning' },
    error: { label: 'Needs attention', className: 'bg-error/15 text-error' },
    disconnected: { label: 'Disconnected', className: 'bg-white/10 text-textMuted' },
  }
  const entry = map[status]
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wide ${entry.className}`}>{entry.label}</span>
}

export default function SalesPage() {
  const [selectedRange, setSelectedRange] = useState(DATE_PRESETS[1])
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [timeseries, setTimeseries] = useState<TimeseriesPoint[]>([])
  const [channels, setChannels] = useState<ChannelResponse[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [summaryRes, seriesRes, channelRes] = await Promise.all([
          fetch(`/api/sales/summary?range=${selectedRange.value}`),
          fetch(`/api/sales/timeseries?range=${selectedRange.value}`),
          fetch(`/api/sales/channels`),
        ])
        if (!summaryRes.ok || !seriesRes.ok || !channelRes.ok) {
          throw new Error('Failed to load sales data')
        }
        const summaryJson = (await summaryRes.json()) as SummaryResponse
        const seriesJson = (await seriesRes.json()) as TimeseriesResponse
        const channelJson = (await channelRes.json()) as { channels: ChannelResponse[] }
        if (!cancelled) {
          setSummary(summaryJson)
          setTimeseries(seriesJson.points)
          setChannels(channelJson.channels)
        }
      } catch (err: any) {
        console.error('[sales] load error', err)
        if (!cancelled) setError(err.message ?? 'Unable to load sales data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [selectedRange])

  const leaderboard = useMemo(() => summary?.leaderboard ?? [], [summary])

  return (
    <main className="flex min-h-screen gap-4 bg-obsidian p-4 text-textPrimary">
      <div className="relative h-[calc(100vh-2rem)]">
        <LeftRail />
      </div>
      <div className="flex flex-1 min-w-0 gap-4">
        <div className="panel flex min-w-0 flex-1 flex-col gap-6 overflow-hidden h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="text-xs uppercase tracking-[0.28em] text-teal/80">Sales intelligence</span>
              <h1 className="text-2xl font-semibold text-white">Stripe-grade analytics across every channel</h1>
              <p className="mt-2 max-w-2xl text-sm text-textMuted">
                Replicator watches your storefronts, mirrors order flow into the print queue, and reconciles payouts so you can see profit in one place.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-2 py-1 text-xs text-textMuted">
              {DATE_PRESETS.map((preset) => {
                const active = preset.value === selectedRange.value
                return (
                  <button
                    key={preset.value}
                    type="button"
                    onClick={() => setSelectedRange(preset)}
                    className={`rounded-full px-3 py-1 transition ${active ? 'bg-teal text-black' : 'hover:text-white'}`}
                  >
                    {preset.label}
                  </button>
                )
              })}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-error/40 bg-error/10 px-4 py-3 text-sm text-error">
              {error}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(summary?.metrics ?? Array.from({ length: 4 })).map((metric, idx) => (
              <SalesKpiCard
                key={metric?.key ?? `placeholder-${idx}`}
                label={metric?.label ?? 'Loading'}
                value={metric ? formatValue(metric) : '—'}
                sublabel={metric?.sublabel}
                delta={metric?.delta}
                deltaDirection={metric?.deltaDirection}
                sparkline={metric?.sparkline}
              />
            ))}
          </div>

          <div className="flex-1 overflow-y-auto pr-1">
            <div className="space-y-6 pb-2">
              <RevenueChart points={timeseries} />

              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="rounded-2xl border border-white/10 bg-black/40 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs uppercase tracking-[0.24em] text-teal/70">Channel coverage</div>
                      <h3 className="text-lg font-semibold text-white">Marketplace connectors</h3>
                    </div>
                    <button type="button" className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-textMuted hover:text-white">
                      Add channel
                    </button>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    {channels.map((channel) => (
                      <div key={channel.id} className="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/30 p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/5 text-base font-semibold text-white">
                              {channel.avatar}
                            </div>
                            <div>
                              <div className="text-sm font-semibold text-white">{channel.name}</div>
                              <div className="text-xs text-textMuted">{formatCurrency(channel.totalSalesCents)} to date</div>
                            </div>
                          </div>
                          <ChannelStatusBadge status={channel.status} />
                        </div>
                        <div className="flex items-center justify-between text-xs text-textMuted">
                          <span>Last sync</span>
                          <span>{channel.lastSync}</span>
                        </div>
                        <div className="flex items-center justify-between text-xs text-textMuted">
                          <span>Pending orders</span>
                          <span className="text-white">{channel.pendingOrders}</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <button type="button" className="rounded-md border border-white/10 px-3 py-1 text-textMuted hover:text-white">
                            Sync now
                          </button>
                          <button type="button" className="rounded-md border border-white/10 px-3 py-1 text-textMuted hover:text-white">
                            Manage
                          </button>
                        </div>
                      </div>
                    ))}
                    {channels.length === 0 && !loading && (
                      <div className="rounded-xl border border-white/10 bg-black/20 p-6 text-sm text-textMuted">
                        Hook up Shopify, Etsy, TikTok Shop, or custom webhooks to see live store health.
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/10 bg-black/40 p-5">
                  <div className="text-xs uppercase tracking-[0.24em] text-teal/70">Highlights</div>
                  <h3 className="mt-1 text-lg font-semibold text-white">What sales learns for you</h3>
                  <ul className="mt-4 space-y-4 text-sm text-textMuted">
                    {FEATURE_CALLOUTS.map((feature) => (
                      <li key={feature.title} className="rounded-lg border border-white/10 bg-black/30 px-3 py-3">
                        <div className="text-sm font-semibold text-white">{feature.title}</div>
                        <p className="mt-1 text-xs leading-relaxed text-textMuted/90">{feature.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-black/40 p-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-[0.24em] text-teal/70">Top movers</div>
                    <h3 className="text-lg font-semibold text-white">Best-selling prints</h3>
                  </div>
                  <button type="button" className="rounded-md border border-white/10 px-3 py-1 text-xs text-textMuted hover:text-white">
                    View catalog
                  </button>
                </div>
                <div className="mt-4 divide-y divide-white/10">
                  {leaderboard.map((entry) => (
                    <div key={entry.product} className="flex items-center justify-between py-3 text-sm">
                      <div className="font-medium text-white">{entry.product}</div>
                      <div className="flex items-center gap-5 text-xs text-textMuted">
                        <span>{entry.orders} orders</span>
                        <span className="text-white">{formatCurrency(entry.revenueCents)}</span>
                      </div>
                    </div>
                  ))}
                  {leaderboard.length === 0 && !loading && (
                    <div className="py-3 text-sm text-textMuted">No catalog data yet. Upload models on the Store tab to generate listings.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="panel flex w-[360px] flex-shrink-0 flex-col gap-4 h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] overflow-hidden p-5">
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-[0.28em] text-teal/70">Operations feed</div>
            <h2 className="text-lg font-semibold text-white">Live sales timeline</h2>
            <p className="text-xs text-textMuted">
              Every payout, sync job, and channel alert lands here so the operator desk knows what changed without digging into dashboards.
            </p>
          </div>
          <div className="flex-1 overflow-y-auto pr-1">
            <ul className="space-y-3">
              {TIMELINE_FEATURES.map((event) => (
                <li key={event.id} className="rounded-xl border border-white/10 bg-black/35 p-4">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-white">{event.title}</div>
                    <span className="text-xs text-textMuted">{event.time}</span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-textMuted/90">{event.description}</p>
                  <div className="mt-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-textMuted/60">
                    <span className={`inline-flex h-1.5 w-1.5 rounded-full ${event.type === 'payout' ? 'bg-teal' : event.type === 'sync' ? 'bg-white/80' : event.type === 'alert' ? 'bg-warning' : 'bg-white/40'}`} />
                    {event.type}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/35 p-4 text-xs text-textMuted">
            <div className="text-sm font-semibold text-white">Next up</div>
            <ul className="mt-2 space-y-2">
              <li>• Enable automated dispute routing into the operator chat stream.</li>
              <li>• Layer in multi-store inventory balancing across printers.</li>
              <li>• Support payout reconciliation across regions and currencies.</li>
            </ul>
          </div>
        </aside>
      </div>
    </main>
  )
}
