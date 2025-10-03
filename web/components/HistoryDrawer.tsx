"use client"

import { useMemo } from 'react'

type DrawerOrder = {
  id: string
  prompt_text?: string | null
  status?: string | null
  created_at?: string | null
}

type HistoryDrawerProps = {
  orders?: DrawerOrder[] | null
  activeOrderId?: string | null
  lastVisitedOrderId?: string | null
  onSelectOrder?: (orderId: string) => void
  onStartNew?: () => void
}

type Tone = 'muted' | 'teal' | 'warning' | 'success'

const STATUS_LOOKUP: Record<string, { label: string; tone: Tone }> = {
  new: { label: 'Specify', tone: 'muted' },
  visualizing: { label: 'Visualizing', tone: 'teal' },
  await_image_pick: { label: 'Select image', tone: 'muted' },
  materializing: { label: 'Materializing', tone: 'teal' },
  repairing: { label: 'Stabilizing', tone: 'teal' },
  slicing: { label: 'Slicing', tone: 'teal' },
  exporting: { label: 'Preparing STL', tone: 'teal' },
  stl_ready: { label: 'STL ready', tone: 'success' },
  ready_to_pay: { label: 'Ready to pay', tone: 'success' },
  paid: { label: 'Authorized', tone: 'success' },
  dispatching: { label: 'Dispatching', tone: 'success' },
  printing: { label: 'Printing', tone: 'success' },
  done: { label: 'Completed', tone: 'success' },
  needs_review: { label: 'Needs review', tone: 'warning' },
  generate_failed: { label: 'Generation failed', tone: 'warning' },
  repair_failed: { label: 'Repair failed', tone: 'warning' },
  slice_failed: { label: 'Slice failed', tone: 'warning' },
  dispatch_failed: { label: 'Dispatch failed', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
}

const TONE_BADGE: Record<Tone, string> = {
  muted: 'border-white/10 bg-white/5 text-textMuted',
  teal: 'border-teal/40 bg-teal/15 text-teal',
  warning: 'border-warning/40 bg-warning/15 text-warning',
  success: 'border-white/15 bg-white/10 text-textPrimary',
}

const DEFAULT_STATUS = { label: 'Specify', badgeClass: TONE_BADGE.muted }

function describeStatus(status?: string | null) {
  if (!status) return DEFAULT_STATUS
  const info = STATUS_LOOKUP[status.toLowerCase()] || STATUS_LOOKUP[status]
  if (!info) return DEFAULT_STATUS
  return { label: info.label, badgeClass: TONE_BADGE[info.tone] }
}

function renderPrompt(prompt?: string | null) {
  if (!prompt) return 'Untitled fabrication'
  const trimmed = prompt.trim()
  if (!trimmed) return 'Untitled fabrication'
  if (trimmed.length <= 80) return trimmed
  return `${trimmed.slice(0, 80)}…`
}

function formatTimestamp(input?: string | null) {
  if (!input) return ''
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = Date.now() - date.getTime()
  if (diffMs < 45_000) return 'Just now'
  if (diffMs < 3_600_000) {
    const mins = Math.max(1, Math.round(diffMs / 60_000))
    return `${mins}m ago`
  }
  if (diffMs < 86_400_000) {
    const hrs = Math.max(1, Math.round(diffMs / 3_600_000))
    return `${hrs}h ago`
  }
  return date.toLocaleDateString()
}

export default function HistoryDrawer({ orders, activeOrderId, lastVisitedOrderId, onSelectOrder, onStartNew }: HistoryDrawerProps) {
  const items = useMemo(() => orders?.filter(Boolean) ?? [], [orders])

  return (
    <div className="flex h-full w-72 flex-col overflow-hidden rounded-xl border border-white/10 bg-black/85 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.28em] text-textMuted">Sessions</span>
        {items.length > 0 && <span className="text-[10px] text-textMuted">{items.length}</span>}
      </div>
      <button
        type="button"
        onClick={onStartNew}
        className="mt-3 w-full rounded-lg border border-teal/40 bg-teal/15 px-3 py-2 text-sm font-semibold text-teal transition hover:bg-teal/20 focus-ring"
      >
        New Fabrication
      </button>
      <div className="mt-4 flex-1 overflow-y-auto pr-1">
        {items.length === 0 ? (
          <div className="mt-10 text-sm text-textMuted">
            No previous jobs yet. Start a new fabrication to populate your history.
          </div>
        ) : (
          items.map((order) => {
            const active = order.id === activeOrderId
            const lastVisited = !active && order.id === lastVisitedOrderId
            const status = describeStatus(order.status)
            const timestamp = formatTimestamp(order.created_at)
            const baseClass = active
              ? 'border-teal/50 bg-teal/15 shadow-[0_0_20px_rgba(46,230,214,0.25)]'
              : lastVisited
              ? 'border-white/15 bg-white/[0.08]'
              : 'border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.08]'
            return (
              <button
                key={order.id}
                type="button"
                onClick={() => onSelectOrder?.(order.id)}
                className={`mb-2 w-full rounded-lg border px-3 py-2 text-left text-sm text-textPrimary transition focus-ring ${baseClass}`}
              >
                <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-textMuted">
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-semibold ${status.badgeClass}`}>
                    {status.label}
                  </span>
                  {timestamp && <span className="text-[10px] text-textMuted">{timestamp}</span>}
                </div>
                <div className="mt-2 text-[13px] leading-snug text-textPrimary">
                  {renderPrompt(order.prompt_text)}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
