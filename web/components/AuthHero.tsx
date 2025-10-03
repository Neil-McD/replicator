"use client"
import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'

const Fallback3D = dynamic(() => import('@/components/AuthPreview3D'), { ssr: false })

export default function AuthHero() {
  const [reduced, setReduced] = useState(false)
  const [sources, setSources] = useState<{ webm?: boolean; mp4?: boolean; poster?: boolean }>({})
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined' && 'matchMedia' in window) {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
      setReduced(!!mq.matches)
      const handler = (e: MediaQueryListEvent) => setReduced(!!e.matches)
      mq.addEventListener?.('change', handler as any)
      return () => mq.removeEventListener?.('change', handler as any)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function head(url: string) {
      try {
        const r = await fetch(url, { method: 'HEAD' })
        return r.ok
      } catch {
        return false
      }
    }
    async function probe() {
      const [webm, mp4, poster] = await Promise.all([
        head('/fabricator-hero.webm'),
        head('/fabricator-hero.mp4'),
        head('/fabricator-hero-poster.jpg'),
      ])
      if (!cancelled) {
        setSources({ webm, mp4, poster })
        setReady(true)
      }
    }
    probe()
    return () => { cancelled = true }
  }, [])

  const hasVideo = useMemo(() => Boolean(sources.webm || sources.mp4), [sources])

  // Respect reduced motion
  if (reduced) {
    return (
      <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black/40">
        <div className="aspect-video w-full" style={{ minHeight: 220 }} />
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-white/10 bg-black/40">
      {ready && hasVideo ? (
        <video
          className="block h-auto w-full"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          {...(sources.poster ? { poster: '/fabricator-hero-poster.jpg' } : {})}
        >
          {sources.webm && <source src="/fabricator-hero.webm" type="video/webm" />}
          {sources.mp4 && <source src="/fabricator-hero.mp4" type="video/mp4" />}
        </video>
      ) : (
        <Fallback3D height={300} />
      )}
      <div className="pointer-events-none absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'linear-gradient(transparent 95%, rgba(255,255,255,0.12) 95%)', backgroundSize: '100% 3px' }} />
    </div>
  )
}
