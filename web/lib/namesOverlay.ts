// Tiny persistent overlay for order display names per user.
// Storage key: replicator:names:{userId} -> { [orderId]: { v: string, pending?: boolean, at: number } }

type Entry = { v: string; pending?: boolean; at: number }

function key(userId: string) {
  return `replicator:names:${userId}`
}

function readMap(userId: string): Record<string, Entry> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(key(userId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed as Record<string, Entry> : {}
  } catch {
    return {}
  }
}

function writeMap(userId: string, map: Record<string, Entry>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key(userId), JSON.stringify(map))
  } catch {}
}

export function get(userId: string, orderId: string): Entry | null {
  const m = readMap(userId)
  return m[orderId] || null
}

export function getAll(userId: string): Record<string, Entry> {
  return readMap(userId)
}

export function set(userId: string, orderId: string, title: string, pending = true) {
  const m = readMap(userId)
  m[orderId] = { v: title, pending, at: Date.now() }
  writeMap(userId, m)
}

export function confirm(userId: string, orderId: string, title: string) {
  const m = readMap(userId)
  const e = m[orderId]
  if (!e) return
  if (e.v === title) {
    // Clear overlay when server matches to keep store tidy
    delete m[orderId]
  } else {
    // Keep the latest local preferred value marked as pending
    m[orderId] = { v: e.v, pending: true, at: e.at }
  }
  writeMap(userId, m)
}

export function remove(userId: string, orderId: string) {
  const m = readMap(userId)
  if (m[orderId]) {
    delete m[orderId]
    writeMap(userId, m)
  }
}

