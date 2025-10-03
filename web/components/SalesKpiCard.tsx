"use client"

import AnalyticsSparkline from './AnalyticsSparkline'

type DeltaDirection = 'up' | 'down' | 'flat'

interface SalesKpiCardProps {
  label: string
  value: string
  delta?: number
  deltaDirection?: DeltaDirection
  sublabel?: string
  sparkline?: number[]
}

function formatDelta(delta?: number, direction?: DeltaDirection) {
  if (delta === undefined || direction === undefined) return null
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '—'
  const color = direction === 'up' ? 'text-teal' : direction === 'down' ? 'text-warning' : 'text-textMuted'
  const formatted = `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`
  return (
    <span className={`text-xs font-medium ${color}`}>
      {arrow} {formatted}
    </span>
  )
}

export default function SalesKpiCard({ label, value, delta, deltaDirection = 'flat', sublabel, sparkline }: SalesKpiCardProps) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-white/10 bg-black/50 p-4 shadow-[0_14px_45px_-40px_rgba(0,0,0,0.9)]">
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-[0.24em] text-textMuted/80">{label}</div>
          <div className="text-2xl font-semibold text-white">{value}</div>
          {sublabel && <div className="text-xs text-textMuted/70">{sublabel}</div>}
        </div>
        {formatDelta(delta, deltaDirection)}
      </div>
      {sparkline && sparkline.length > 0 && (
        <div className="mt-4">
          <AnalyticsSparkline values={sparkline} />
        </div>
      )}
    </div>
  )
}
