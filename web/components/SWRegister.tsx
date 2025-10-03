"use client"
import { useEffect } from 'react'

export default function SWRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const prod = process.env.NODE_ENV === 'production'
    const enabled = true // enable in dev too for local testing
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
