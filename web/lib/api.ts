"use client"
import { authedFetch } from './clientAuth'

export type OrderAsset = { id: string; kind: string; signed_url?: string | null; url: string; created_at: string }
export type OrderRecord = { id: string; status: string; quote_json?: any; created_at: string }

export async function createOrder(prompt: string) {
  const res = await authedFetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt_text: prompt }),
  })
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error || message
    } catch {}
    const err: any = new Error(message)
    err.status = res.status
    throw err
  }
  return (await res.json()) as { order_id: string }
}

export async function getOrder(orderId: string) {
  const res = await authedFetch(`/api/orders/${orderId}`, { cache: 'no-store' })
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error || message
    } catch {}
    const err: any = new Error(message)
    err.status = res.status
    throw err
  }
  return (await res.json()) as { order: OrderRecord; assets: OrderAsset[] }
}

export async function createCheckout(orderId: string, quantity?: number) {
  const res = await authedFetch('/api/stripe/create-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: orderId, quantity }),
  })
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error || message
    } catch {}
    const err: any = new Error(message)
    err.status = res.status
    throw err
  }
  return (await res.json()) as { url?: string }
}

export async function deleteOrderChat(orderId: string) {
  const res = await authedFetch(`/api/orders/${orderId}/chat`, { method: 'DELETE' })
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error || message
    } catch {}
    const err: any = new Error(message)
    err.status = res.status
    throw err
  }
  return (await res.json()) as { ok: boolean }
}

export async function cancelOrder(orderId: string, payload: Record<string, any> = {}) {
  const res = await authedFetch(`/api/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error || message
    } catch {}
    const err: any = new Error(message)
    err.status = res.status
    throw err
  }
  return (await res.json()) as { ok: boolean; status?: string }
}
