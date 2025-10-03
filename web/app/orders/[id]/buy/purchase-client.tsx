"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authedFetch } from '@/lib/clientAuth'
import { createCheckout } from '@/lib/api'

const BUILD_MAX = Math.max(20, Number(process.env.NEXT_PUBLIC_BUILD_VOLUME_X_MM || 230))

export default function BuyClient({ orderId, initialStatus, initialQuote }: { orderId: string; initialStatus?: string | null; initialQuote?: any }) {
  const [status, setStatus] = useState<string | null>(initialStatus || null)
  const [quote, setQuote] = useState<any | null>(initialQuote || null)
  const [target, setTarget] = useState<number>(Math.min(100, BUILD_MAX))
  const [loading, setLoading] = useState<boolean>(false)
  const [resizing, setResizing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [polling, setPolling] = useState<boolean>(false)

  const readyToPay = status === 'ready_to_pay' && quote && typeof quote.price_cents === 'number'

  const summary = useMemo(() => {
    const mins = quote?.minutes != null ? `${Math.round(quote.minutes)} min` : '—'
    const grams = quote?.grams != null ? `${Math.round(quote.grams)} g` : '—'
    const price = typeof quote?.price_cents === 'number' ? `$${(quote.price_cents/100).toFixed(2)}` : '—'
    return `${mins} · ${grams} · ${price}`
  }, [quote])

  const pollOrder = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/orders/${orderId}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setStatus(data.order?.status || null)
      if (data.order?.quote_json) setQuote(data.order.quote_json)
    } catch {}
  }, [orderId])

  // Basic poller when we are processing
  useEffect(() => {
    if (!polling) return
    let timer: any
    const tick = async () => {
      await pollOrder()
      timer = setTimeout(tick, 2000)
    }
    tick()
    return () => { if (timer) clearTimeout(timer) }
  }, [polling, pollOrder])

  const queueSlice = useCallback(async () => {
    setError(null)
    setResizing(true)
    try {
      // Store transform first so the worker slices at the requested size
      await authedFetch(`/api/orders/${orderId}/transform`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_max_dim_mm: target }),
      })
      // Move order to slicing
      const r = await authedFetch(`/api/orders/${orderId}/slice`, { method: 'POST' })
      if (!r.ok) {
        const t = await r.text().catch(()=> '')
        setError(t || 'Failed to queue slice')
        setResizing(false)
        return
      }
      setPolling(true)
    } catch (e: any) {
      setError(e?.message || 'Failed to queue slice')
      setResizing(false)
    }
  }, [orderId, target])

  const handlePay = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { url } = await createCheckout(orderId)
      if (url) window.location.href = url
      else setError('Checkout unavailable')
    } catch (e: any) {
      setError(e?.message || 'Failed to create checkout')
    } finally {
      setLoading(false)
    }
  }, [orderId])

  const disabledPay = !readyToPay || loading || resizing
  const disabledSize = resizing || loading

  return (
    <div>
      <div className="text-sm text-textMuted">Quote</div>
      <div className="mt-1 text-lg">{summary}</div>
      {status !== 'ready_to_pay' && (
        <div className="mt-2 rounded bg-warning/15 px-2 py-1 text-[12px] text-warning">Print check running — update quote will unlock payment.</div>
      )}
      <div className="mt-4">
        <div className="flex items-center justify-between text-xs text-textMuted">
          <span>Max dimension</span>
          <span className="text-textPrimary tabular-nums">{Math.round(target)} mm</span>
        </div>
        <input
          type="range"
          min={20}
          max={BUILD_MAX}
          step={1}
          value={target}
          onChange={(e) => setTarget(Number(e.target.value))}
          disabled={disabledSize}
          className="w-full"
        />
        <button
          type="button"
          onClick={queueSlice}
          disabled={disabledSize}
          className="mt-2 w-full rounded border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10 disabled:opacity-60"
        >
          {resizing ? 'Updating quote…' : 'Update quote for this size'}
        </button>
      </div>
      <button
        type="button"
        onClick={handlePay}
        disabled={disabledPay}
        className="mt-4 w-full rounded bg-teal px-3 py-2 text-sm text-black disabled:opacity-60"
      >
        {loading ? 'Opening checkout…' : 'Pay with Stripe'}
      </button>
      {error && <div className="mt-2 rounded bg-warning/15 px-2 py-1 text-[12px] text-warning">{error}</div>}
      <div className="mt-3 text-xs text-textMuted">Status: {status || '—'}</div>
    </div>
  )
}

