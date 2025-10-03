"use client"
import { useEffect, useState } from 'react'
import { authedFetch } from '@/lib/clientAuth'

export default function PrintNowButton({ orderId }: { orderId: string }) {
  const [link, setLink] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasThreeMF, setHasThreeMF] = useState<boolean>(true)

  async function onClick() {
    setLoading(true)
    setError(null)
    try {
      const res = await authedFetch(`/api/orders/${orderId}/print-now`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'failed')
      setLink(data.link)
    } catch (e: any) {
      setError(e?.message || 'print failed')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    const run = async () => {
      try {
        const res = await authedFetch(`/api/orders/${orderId}`)
        if (!res.ok) return
        const payload = await res.json().catch(() => null)
        const assets = Array.isArray(payload?.assets) ? payload.assets : []
        const has = assets.some((a: any) => (a?.kind || '').toLowerCase() === 'three_mf')
        if (active) setHasThreeMF(has)
      } catch {
        // ignore
      }
    }
    run().catch(() => {})
    return () => { active = false }
  }, [orderId])

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onClick}
        disabled={loading || !hasThreeMF}
        className="rounded-mdx bg-teal px-3 py-1.5 text-sm font-medium text-black hover:brightness-110 disabled:opacity-50"
      >
        {loading ? 'Preparing…' : hasThreeMF ? 'Print now' : '3MF pending'}
      </button>
      {link && (
        <a href={link} className="text-xs text-teal underline" target="_blank" rel="noreferrer">Open in Bambu Connect</a>
      )}
      {error && (
        <span className="text-xs text-red-400">{error}</span>
      )}
    </div>
  )
}
