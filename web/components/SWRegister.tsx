"use client"
import { useEffect } from 'react'

export default function SWRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const flag = (process.env.NEXT_PUBLIC_ENABLE_SW || '0').toLowerCase()
    const enabled = ['1','true','yes','on'].includes(flag)
    if (!enabled) return
    const url = '/sw.js'
    navigator.serviceWorker
      .register(url, { scope: '/' })
      .then(() => {
        // Request persistent storage to reduce OPFS eviction risk
        try { navigator.storage && navigator.storage.persist && navigator.storage.persist() } catch {}
      })
      .catch((err) => {
        console.warn('[SW] register failed', err)
      })
  }, [])
  return null
}
