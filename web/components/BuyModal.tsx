"use client"

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authedFetch } from '@/lib/clientAuth'
import { createCheckout } from '@/lib/api'

const BUILD_MAX = Math.max(20, Number(process.env.NEXT_PUBLIC_BUILD_VOLUME_X_MM || 230))

export default function BuyModal({ open, orderId, sizeMm, onClose }: { open: boolean; orderId: string; sizeMm?: number | null; onClose: () => void }) {
  const [status, setStatus] = useState<string | null>(null)
  const [quote, setQuote] = useState<any>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [qty, setQty] = useState<number>(1)
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const priceCents = quote?.total_cents ?? quote?.price_cents ?? null
  const readyToPay = status === 'ready_to_pay' && typeof priceCents === 'number'
  const unitPrice = typeof priceCents === 'number' ? `$${(priceCents/100).toFixed(2)}` : '—'
  const totalPrice = typeof priceCents === 'number' ? `$${((priceCents * qty)/100).toFixed(2)}` : '—'

  const pollOrder = useCallback(async () => {
    try {
      const res = await authedFetch(`/api/orders/${orderId}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setStatus(data.order?.status || null)
      const q = data.order?.quote_json
      if (q) setQuote(q)
      const prev = (data.assets || []).find((a: any) => a.kind === 'slicer_preview_png')
      if (prev?.signed_url) setPreviewUrl(prev.signed_url)
    } catch {}
  }, [orderId])

  useEffect(() => {
    if (!open) return
    let cancel = false
    ;(async () => {
      if (cancel) return
      try {
        const res = await authedFetch(`/api/orders/${orderId}`, { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json()
          setStatus(data.order?.status || null)
          const q = data.order?.quote_json
          if (q) setQuote(q)
          const prev = (data.assets || []).find((a: any) => a.kind === 'slicer_preview_png')
          if (prev?.signed_url) setPreviewUrl(prev.signed_url)
        }
      } catch {}
    })()
    return () => { cancel = true }
  }, [open, pollOrder])

  // While open, poll for price/preview until ready_to_pay to ensure seamless update
  useEffect(() => {
    if (!open) return
    let timer: any = null
    let stopped = false
    const tick = async () => {
      if (stopped) return
      await pollOrder()
      const ready = (status === 'ready_to_pay') && (typeof priceCents === 'number')
      if (!ready) timer = setTimeout(tick, 1500)
    }
    tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [open, pollOrder, status, priceCents])

  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = original
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  // Size is imported from the viewer baseline; no size controls in this modal.

  const handlePay = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { url } = await createCheckout(orderId, qty)
      if (url) window.location.href = url
      else setError('Checkout unavailable')
    } catch (e: any) {
      setError(e?.message || 'Failed to create checkout')
    } finally {
      setLoading(false)
    }
  }, [orderId, qty])

  const handleContinueEditing = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authedFetch(`/api/orders/${orderId}/continue-editing`, {
        method: 'POST'
      })
      if (!res.ok) {
        throw new Error('Failed to unlock editing')
      }
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Failed to continue editing')
    } finally {
      setLoading(false)
    }
  }, [orderId, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden onClick={loading ? undefined : onClose} />
      <div className="panel relative z-10 w-[min(680px,calc(100vw-2rem))] max-w-full overflow-hidden">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-[0.28em] text-teal/70">Purchase</div>
            <h2 className="text-base font-semibold text-white">Confirm size and pay</h2>
          </div>
          <button className="text-sm text-textMuted hover:text-white" onClick={onClose} disabled={loading}>Close</button>
        </header>
        <div className="p-4 flex flex-col gap-4 lg:flex-row">
          <div className="flex-1">
            <div className="text-sm text-textMuted">Model</div>
            <div className="mt-1 aspect-square w-full overflow-hidden rounded-mdx border border-white/10 bg-black/30">
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl} alt="Preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-textMuted">Preview pending</div>
              )}
            </div>
          </div>
          <div className="w-full lg:max-w-[300px]">
            <div className="text-sm text-textMuted">Size</div>
            <div className="mt-1 text-lg">{sizeMm != null ? `${Math.round(sizeMm)} mm` : '—'}</div>

            {quote && quote.product_cents != null ? (
              <div className="mt-4 space-y-2 rounded border border-white/10 bg-black/20 p-3">
                <div className="text-xs uppercase tracking-[0.24em] text-textMuted/70">Price Breakdown</div>
                <div className="flex justify-between text-sm">
                  <span className="text-textMuted">Product</span>
                  <span className="font-mono text-textPrimary">${(quote.product_cents / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-textMuted">Labor & handling</span>
                  <span className="font-mono text-textPrimary">${(quote.labor_cents / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-textMuted">Shipping</span>
                  <span className="font-mono text-textPrimary">${(quote.shipping_cents / 100).toFixed(2)}</span>
                </div>
                <div className="border-t border-white/10 pt-2 flex justify-between text-base font-medium">
                  <span className="text-textPrimary">Total</span>
                  <span className="font-mono text-teal">{unitPrice}</span>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-4 text-sm text-textMuted">Price (per unit)</div>
                <div className="mt-1 text-lg">{unitPrice}</div>
              </>
            )}
            <div className="mt-4">
              <div className="flex items-center justify-between text-xs text-textMuted">
                <span>Quantity</span>
                <span className="text-textPrimary tabular-nums">{qty}</span>
              </div>
              <input
                type="number"
                min={1}
                max={Number(process.env.NEXT_PUBLIC_CHECKOUT_MAX_QTY || 20)}
                step={1}
                value={qty}
                onChange={(e) => setQty(Math.max(1, Math.min(Number(process.env.NEXT_PUBLIC_CHECKOUT_MAX_QTY || 20), Number(e.target.value) || 1)))}
                className="mt-1 w-full rounded border border-white/15 bg-black/30 px-2 py-1 text-sm"
                disabled={loading}
              />
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-textMuted">Total</span>
                <span className="text-textPrimary font-medium">{totalPrice}</span>
              </div>
              <button
                type="button"
                onClick={handlePay}
                disabled={!readyToPay || loading}
                className="mt-3 w-full rounded bg-teal px-3 py-2 text-sm text-black disabled:opacity-60"
              >
                {loading ? 'Opening checkout…' : 'Pay with Stripe'}
              </button>
              <button
                type="button"
                onClick={handleContinueEditing}
                disabled={loading}
                className="mt-2 w-full rounded border border-white/20 bg-transparent px-3 py-2 text-sm text-textMuted hover:text-white disabled:opacity-60"
              >
                ↩ Keep editing this model
              </button>
              {error && <div className="mt-2 rounded bg-warning/15 px-2 py-1 text-[12px] text-warning">{error}</div>}
              <div className="mt-3 text-xs text-textMuted">Status: {status || '—'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
