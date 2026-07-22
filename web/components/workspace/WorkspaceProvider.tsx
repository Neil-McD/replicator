"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { authedFetch, getAccessToken } from '@/lib/clientAuth'
import { supabaseBrowser } from '@/lib/supabaseClient'
import type { ContextSnapshot } from '@/lib/context'
import { createOrder } from '@/lib/api'

export type LocalPreviewState = {
  url: string
  ext?: string | null
  kind?: 'stl' | 'glb' | 'gltf' | 'obj' | 'toolpath'
  assetKind?: string | null
  assetId?: string | null
  createdAt?: string | number | null
  source?: 'sse' | 'poll' | 'rehydrate' | 'manual' | 'refresh'
  storageUrl?: string | null
  expiresAt?: number | null
  previewUrl?: string | null
  previewExpiresAt?: number | null
  meta?: any
}

export type OrderSummary = {
  id: string
  prompt_text?: string | null
  title?: string | null
  updated_at?: string | null
  status?: string | null
  created_at?: string | null
}

export type WorkspaceContextValue = {
  orderId: string | null
  lastVisitedOrderId: string | null
  orderRevision: number
  sessions: OrderSummary[]
  loadingSnapshot: boolean
  initialMessages: ContextSnapshot['messages'] | null
  initialStatus: string | null
  initialAttachments: ContextSnapshot['attachments'] | null
  localPreview: LocalPreviewState | null
  selectOrder: (id: string) => void
  startNewOrder: () => Promise<void>
  handleOrderCreated: (id: string) => void
  handleViewerFocus: (
    kind: 'stl' | 'glb' | 'gltf' | 'obj' | 'toolpath',
    url: string,
    assetKind?: string | null,
    meta?: {
      assetId?: string | null
      createdAt?: string | number | null
      storageUrl?: string | null
      expiresAt?: number | null
      metrics?: any
    }
  ) => void
  resetWorkspace: (orderId?: string | null) => void
  refreshSessions: () => Promise<void>
  ensureSnapshotFresh: (
    orderId?: string | null,
    options?: { force?: boolean; apply?: boolean; showSpinner?: boolean; signal?: AbortSignal }
  ) => Promise<void>
}

const LAST_ORDER_STORAGE_KEY = 'replicator:last-order-id'
const SIZE_STORAGE_PREFIX = 'replicator:size:'

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined)

function isExpiring(timestamp: number | null | undefined, thresholdMs: number, now: number) {
  if (timestamp == null) return false
  if (!Number.isFinite(timestamp)) return false
  return timestamp - now <= thresholdMs
}

function snapshotExpiresSoon(snap: ContextSnapshot | null | undefined, thresholdMs = 120_000): boolean {
  if (!snap) return false
  const now = Date.now()
  if (snap.images?.some((img) => isExpiring(img.expires_at, thresholdMs, now))) return true
  if (snap.geometry) {
    if (isExpiring(snap.geometry.expires_at, thresholdMs, now)) return true
    if (isExpiring(snap.geometry.preview_expires_at, thresholdMs, now)) return true
  }
  if (snap.toolpath) {
    if (isExpiring(snap.toolpath.three_mf_expires_at, thresholdMs, now)) return true
    if (isExpiring(snap.toolpath.preview_expires_at, thresholdMs, now)) return true
  }
  if (Array.isArray(snap.messages)) {
    for (const msg of snap.messages) {
      if (!msg || !msg.content) continue
      const content: any = msg.content
      if (Array.isArray(content?.images)) {
        if (content.images.some((img: any) => isExpiring(img?.expires_at, thresholdMs, now))) return true
      }
      if (isExpiring(content?.expires_at, thresholdMs, now)) return true
    }
  }
  return false
}

function snapshotIsPristine(snap: ContextSnapshot | null | undefined): boolean {
  if (!snap) return false
  const status = typeof snap.status === 'string' ? snap.status.toLowerCase() : null
  if (status && status !== 'new') return false
  if (Array.isArray(snap.messages) && snap.messages.length > 0) return false
  if (Array.isArray(snap.images) && snap.images.length > 0) return false
  if (Array.isArray(snap.angles) && snap.angles.some((group) => (group?.images?.length ?? 0) > 0)) return false
  if (snap.selected_image_id) return false
  if (typeof snap.chosen_index === 'number') return false
  if (snap.geometry?.stl_url || snap.geometry?.asset_id) return false
  if (snap.toolpath?.three_mf_url || snap.toolpath?.preview_url) return false
  if (snap.quote && (snap.quote.minutes || snap.quote.grams || snap.quote.price_cents || snap.quote.total_cents)) return false
  if (snap.transform && Number.isFinite(snap.transform.target_max_dim_mm ?? NaN)) return false
  return true
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [orderId, setOrderId] = useState<string | null>(null)
  const [lastVisitedOrderId, setLastVisitedOrderId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<OrderSummary[]>([])
  const [initialMessages, setInitialMessages] = useState<ContextSnapshot['messages'] | null>(null)
  const [initialStatus, setInitialStatus] = useState<string | null>(null)
  const [initialAttachments, setInitialAttachments] = useState<ContextSnapshot['attachments'] | null>(null)
  const [localPreview, setLocalPreview] = useState<LocalPreviewState | null>(null)
  const [orderRevision, setOrderRevision] = useState<number>(0)
  const [loadingSnapshot, setLoadingSnapshot] = useState<boolean>(false)

  const contextCacheRef = useRef<Map<string, ContextSnapshot>>(new Map())
  const snapshotFetchesRef = useRef<Map<string, Promise<ContextSnapshot | null>>>(new Map())
  const activeOrderIdRef = useRef<string | null>(null)
  const snapshotAbortRef = useRef<AbortController | null>(null)
  const creatingOrderRef = useRef<boolean>(false)

  const fetchRecentOrders = useCallback(async (): Promise<OrderSummary[]> => {
    try {
      const {
        data: { user },
      } = await supabaseBrowser.auth.getUser()
      if (!user) return []
      let list: OrderSummary[] | null = null
      // Prefer title (new schema). If the column doesn't exist yet, fall back gracefully.
      const q1 = await supabaseBrowser
        .from('orders')
        .select('id,status,created_at,prompt_text,title,updated_at,first_activity_at')
        .eq('user_id', user.id)
        .not('first_activity_at', 'is', null)
        .order('first_activity_at', { ascending: false })
        .limit(20)
      if (q1.error) {
        // Fallback: omit title if migration not yet applied
        const q2 = await supabaseBrowser
          .from('orders')
          .select('id,status,created_at,prompt_text,updated_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(20)
        if (q2.error || !q2.data) return []
        list = q2.data as OrderSummary[]
      } else {
        list = (q1.data || []) as OrderSummary[]
      }
      // Merge overlay: if an overlay exists and matches server, drop it; else keep it (for display consumers)
      try {
        const overlay = (await import('@/lib/namesOverlay')).getAll(user.id)
        // Clean confirmed overlays (when overlay equals server title or prompt_text)
        const ovMod = await import('@/lib/namesOverlay')
        for (const row of (list || [])) {
          const ent = overlay[row.id]
          const serverName = (row.title ?? row.prompt_text) || ''
          if (ent && ent.v && ent.v === serverName) {
            ovMod.remove(user.id, row.id)
          }
        }
      } catch {}
      return list || []
    } catch (err) {
      console.warn('[Workspace] failed to fetch orders', err)
      return []
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    const orders = await fetchRecentOrders()
    setSessions(orders)
  }, [fetchRecentOrders])

  const applySnapshotToState = useCallback(
    (targetId: string | null, snap: ContextSnapshot | null, options?: { source?: 'cache' | 'refresh' | 'reset'; force?: boolean }) => {
      if (!targetId) {
        setInitialMessages(null)
        setInitialStatus(null)
        setInitialAttachments(null)
        setLocalPreview(null)
        return
      }
      if (!options?.force && activeOrderIdRef.current !== targetId) {
        return
      }
      if (!snap) {
        setInitialMessages(null)
        setInitialStatus(null)
        setInitialAttachments(null)
        setLocalPreview(null)
        return
      }
      const history = Array.isArray(snap.messages) && snap.messages.length ? [...snap.messages] : []
      setInitialMessages(history)
      setInitialStatus(snap.status ?? null)
      setInitialAttachments(Array.isArray(snap.attachments) && snap.attachments.length ? [...snap.attachments] : null)
      const geometry = snap.geometry
      if (geometry?.viewer_url || geometry?.stl_url) {
        // Prefer viewer-optimized GLB via content-addressed gateway when available
        let kind: LocalPreviewState['kind'] = 'stl'
        let url = geometry.stl_url!
        let meta: any = geometry.metrics ?? null
        if (geometry.viewer_url) {
          kind = 'glb'
          url = geometry.viewer_url
          // Prefer viewer meta when present (carries viewer=true, target size, etc.)
          meta = geometry.viewer_meta ?? meta
          if (meta && typeof meta === 'object') {
            try { meta.viewer = true } catch {}
          } else {
            meta = { viewer: true }
          }
        }
        // If we have a content hash, route through artifact gateway with token param for auth
        const sha = geometry.viewer_sha256 || geometry.sha256 || null
        if (sha) {
          // We do not await token here to avoid blocking UI; fall back to signed URL if token load fails.
          ;(async () => {
            try {
              const token = await getAccessToken()
              if (token) {
                const gateway = `/api/artifacts/${encodeURIComponent(sha)}?at=${encodeURIComponent(token)}`
                setLocalPreview({
                  url: gateway,
                  kind: kind === 'glb' ? 'glb' : 'stl',
                  ext: kind === 'glb' ? 'glb' : 'stl',
                  assetKind: geometry.kind ?? null,
                  assetId: geometry.asset_id ?? null,
                  source: options?.source === 'cache' ? 'rehydrate' : 'refresh',
                  storageUrl: geometry.storage_url ?? null,
                  expiresAt: geometry.expires_at ?? null,
                  previewUrl: geometry.preview_url ?? null,
                  previewExpiresAt: geometry.preview_expires_at ?? null,
                  meta,
                })
                return
              }
            } catch {}
            // Fallback to signed URL if token missing
            setLocalPreview({
              url,
              kind,
              ext: kind,
              assetKind: geometry.kind ?? null,
              assetId: geometry.asset_id ?? null,
              source: options?.source === 'cache' ? 'rehydrate' : 'refresh',
              storageUrl: geometry.storage_url ?? null,
              expiresAt: geometry.expires_at ?? null,
              previewUrl: geometry.preview_url ?? null,
              previewExpiresAt: geometry.preview_expires_at ?? null,
              meta,
            })
          })()
        } else {
          setLocalPreview({
            url,
            kind,
            ext: kind,
            assetKind: geometry.kind ?? null,
            assetId: geometry.asset_id ?? null,
            source: options?.source === 'cache' ? 'rehydrate' : 'refresh',
            storageUrl: geometry.storage_url ?? null,
            expiresAt: geometry.expires_at ?? null,
            previewUrl: geometry.preview_url ?? null,
            previewExpiresAt: geometry.preview_expires_at ?? null,
            meta,
          })
        }
      } else {
        setLocalPreview(null)
      }

      // Opportunistically pre-cache small preview images (geometry and toolpath)
      ;(async () => {
        try {
          if (typeof window === 'undefined') return
          // @ts-ignore
          if (!('caches' in window)) return
          const cache = await caches.open('replicator-img-v1')
          const urls = new Set<string>()
          const gp = snap.geometry?.preview_url
          const tp = snap.toolpath?.preview_url
          if (typeof gp === 'string' && gp) urls.add(gp)
          if (typeof tp === 'string' && tp) urls.add(tp)
          if (!urls.size) return
          await Promise.all(Array.from(urls).map(async (u) => {
            try {
              const req = new Request(u, { method: 'GET' })
              const existing = await cache.match(req)
              if (existing) return
              const res = await fetch(u, { cache: 'reload', mode: 'no-cors' })
              await cache.put(req, res.clone())
            } catch {}
          }))
        } catch {}
      })()
    },
    []
  )

  // Send a hydrate manifest to the service worker so artifacts are prefetched into the capsule cache
  const postHydrateToSW = useCallback(async (snap: ContextSnapshot | null) => {
    try {
      if (typeof window === 'undefined') return
      if (!snap?.orderId) return
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg?.active) return
      const assets: { sha?: string | null; url: string }[] = []
      const shaList: string[] = []
      const token = await getAccessToken().catch(() => null)
      const addSha = (sha?: string | null) => {
        if (!sha || shaList.includes(sha)) return
        shaList.push(sha)
        const u = token ? `/api/artifacts/${encodeURIComponent(sha)}?at=${encodeURIComponent(token)}` : `/api/artifacts/${encodeURIComponent(sha)}`
        assets.push({ sha, url: u })
      }
      if (snap.geometry?.viewer_sha256) addSha(snap.geometry.viewer_sha256)
      if (snap.geometry?.sha256) addSha(snap.geometry.sha256)
      if (!assets.length) return
      reg.active.postMessage({ type: 'HYDRATE_ORDER', orderId: snap.orderId, assets })
    } catch {}
  }, [])

  // Pre-cache chat images (candidates/angles) in Cache Storage for faster rehydrate
  useEffect(() => {
    if (typeof window === 'undefined') return
    const list = initialMessages
    if (!Array.isArray(list) || list.length === 0) return
    let cancelled = false
    ;(async () => {
      try {
        // @ts-ignore
        if (!('caches' in window)) return
        const cache = await caches.open('replicator-img-v1')
        const urls = new Set<string>()
        for (const m of list) {
          const type = (m as any)?.type
          const content: any = (m as any)?.content
          if (type === 'card.images' && Array.isArray(content?.images)) {
            for (const img of content.images) {
              const u = typeof img?.url === 'string' ? img.url : null
              if (u) urls.add(u)
            }
          }
        }
        if (urls.size === 0) return
        await Promise.all(Array.from(urls).slice(0, 20).map(async (u) => {
          try {
            const req = new Request(u, { method: 'GET' })
            const existing = await cache.match(req)
            if (existing) return
            const res = await fetch(u, { cache: 'reload', mode: 'no-cors' })
            if (!cancelled && res) {
              await cache.put(req, res.clone())
              // LRU record and prune (limit 60)
              try {
                const raw = window.localStorage.getItem('replicator:img:lru')
                const m = raw ? (JSON.parse(raw) as Record<string, number>) : {}
                m[u] = Date.now()
                window.localStorage.setItem('replicator:img:lru', JSON.stringify(m))
                const keys = await cache.keys()
                const limit = 60
                if (keys.length > limit) {
                  const entries = keys.map((k) => ({ url: k.url, at: Number(m[k.url] || 0) }))
                  entries.sort((a, b) => a.at - b.at)
                  const toDelete = entries.slice(0, Math.max(0, entries.length - limit))
                  for (const e of toDelete) {
                    try { await cache.delete(e.url) } catch {}
                    delete m[e.url]
                  }
                  window.localStorage.setItem('replicator:img:lru', JSON.stringify(m))
                }
              } catch {}
            }
          } catch {}
        }))
      } catch {}
    })()
    return () => { cancelled = true }
  }, [initialMessages])

  const handleViewerFocus = useCallback<WorkspaceContextValue['handleViewerFocus']>(
    (kind, url, assetKind, meta) => {
      const currentOrder = orderId
      const existing = currentOrder ? contextCacheRef.current.get(currentOrder) ?? null : null
      // When a content hash is provided, prefer the artifact gateway with token to avoid signed URL flakiness
      const applyLocal = async () => {
        let resolvedUrl = url
        try {
          const sha = (meta as any)?.sha256 || null
          if (sha) {
            const token = await getAccessToken().catch(() => null)
            if (token) {
              resolvedUrl = `/api/artifacts/${encodeURIComponent(sha)}?at=${encodeURIComponent(token)}`
            }
          }
        } catch {}
        setLocalPreview({
          url: resolvedUrl,
          kind,
          assetKind: assetKind ?? null,
          assetId: meta?.assetId ?? null,
          createdAt: meta?.createdAt ?? null,
          source: 'sse',
          storageUrl: meta?.storageUrl ?? existing?.geometry?.storage_url ?? null,
          expiresAt: meta?.expiresAt ?? null,
          meta: meta?.metrics ?? existing?.geometry?.metrics ?? null,
        })
      }
      void applyLocal()
      if (currentOrder && existing) {
        contextCacheRef.current.set(currentOrder, {
          ...existing,
          geometry: {
            ...(existing.geometry ?? {}),
            stl_url: url,
            kind: assetKind ?? existing.geometry?.kind ?? null,
            asset_id: meta?.assetId ?? existing.geometry?.asset_id ?? null,
            storage_url: meta?.storageUrl ?? existing.geometry?.storage_url ?? null,
            expires_at: meta?.expiresAt ?? existing.geometry?.expires_at ?? null,
            metrics: meta?.metrics ?? existing.geometry?.metrics ?? null,
          },
        })
      }
    },
    [orderId]
  )

  const handleOrderCreated = useCallback<WorkspaceContextValue['handleOrderCreated']>(
    (id) => {
      if (!id) return
      // Proactively clear any warm cache for previous active order to ensure fresh canvas UX
      if (activeOrderIdRef.current && activeOrderIdRef.current !== id) {
        try {
          window.sessionStorage.removeItem(`replicator:ss:${activeOrderIdRef.current}`)
          window.localStorage.removeItem(`${SIZE_STORAGE_PREFIX}${activeOrderIdRef.current}`)
        } catch {}
      }
      setOrderId(id)
      setLastVisitedOrderId(id)
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(LAST_ORDER_STORAGE_KEY, id)
        } catch {}
      }
      refreshSessions().catch(() => {})
    },
    [refreshSessions]
  )

  const resetWorkspace = useCallback<WorkspaceContextValue['resetWorkspace']>((currentOrderId) => {
    if (currentOrderId) {
      contextCacheRef.current.delete(currentOrderId)
      snapshotFetchesRef.current.delete(currentOrderId)
    }
    snapshotAbortRef.current?.abort()
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem(LAST_ORDER_STORAGE_KEY)
        if (currentOrderId) {
          window.localStorage.removeItem(`${SIZE_STORAGE_PREFIX}${currentOrderId}`)
          // Proactively clear warm snapshot cache for the order being reset
          try { window.sessionStorage.removeItem(`replicator:ss:${currentOrderId}`) } catch {}
        }
      } catch {}
    }
    setOrderId(null)
    setLastVisitedOrderId(null)
    setInitialMessages(null)
    setInitialStatus(null)
    setInitialAttachments(null)
    setLocalPreview(null)
  }, [])

  const fetchSnapshot = useCallback(
    async (
      targetId: string,
      options: { signal?: AbortSignal; apply?: boolean; force?: boolean } = {}
    ): Promise<ContextSnapshot | null> => {
      if (!targetId) return null
      if (options.signal?.aborted) return null
      const reuse = snapshotFetchesRef.current.get(targetId)
      if (reuse && !options.force) {
        return reuse
      }
      const promise = (async () => {
        try {
          const token = await getAccessToken()
          if (!token || options.signal?.aborted) return null
          const params = new URLSearchParams({ orderId: targetId })
          if (options.force) params.set('fresh', '1')
          const res = await authedFetch(`/api/context/refresh?${params.toString()}`, {
            signal: options.signal,
          })
          if (options.signal?.aborted) return null
          if (!res.ok) {
            if (res.status === 401) {
              resetWorkspace(targetId)
              contextCacheRef.current.clear()
            }
            return null
          }
          const snap = (await res.json()) as ContextSnapshot
          ;(snap as any).fetched_at = Date.now()
          contextCacheRef.current.set(targetId, snap)
          // Persist a trimmed warm snapshot to sessionStorage for instant rehydrate
          try {
            const copy: ContextSnapshot = JSON.parse(JSON.stringify(snap))
            if (Array.isArray(copy.messages) && copy.messages.length > 40) {
              copy.messages = copy.messages.slice(-40)
            }
            // Attach minimal integrity for fast validation on read
            try {
              const { data: { user: me } } = await supabaseBrowser.auth.getUser()
              ;(copy as any).owner_user_id = me?.id ?? null
            } catch {}
            const key = `replicator:ss:${targetId}`
            if (typeof window !== 'undefined') {
              window.sessionStorage.setItem(key, JSON.stringify(copy))
            }
          } catch {}
          if ((options.apply ?? true) && activeOrderIdRef.current === targetId) {
            applySnapshotToState(targetId, snap, { source: 'refresh', force: true })
          }
          // Hint SW to hydrate artifacts for this order (content-addressed)
          try { postHydrateToSW(snap) } catch {}
          return snap
        } catch (err) {
          if (!options.signal?.aborted) {
            console.warn('[Workspace] snapshot fetch failed', err)
          }
          return null
        } finally {
          snapshotFetchesRef.current.delete(targetId)
        }
      })()
      snapshotFetchesRef.current.set(targetId, promise)
      return promise
    },
    [applySnapshotToState, resetWorkspace]
  )

  const ensureSnapshotFresh = useCallback<WorkspaceContextValue['ensureSnapshotFresh']>(
    async (id, options = {}) => {
      const targetId = id ?? orderId
      if (!targetId) return
      const snap = contextCacheRef.current.get(targetId) ?? null
      const needsFetch = options.force === true || !snap || snapshotExpiresSoon(snap)
      if (!needsFetch) return
      const apply = options.apply ?? targetId === orderId
      const defaultSpinner = apply && targetId === orderId
      const showSpinner =
        options.showSpinner !== undefined
          ? options.showSpinner
          : options.force === true
          ? true
          : defaultSpinner
      if (showSpinner) setLoadingSnapshot(true)
      try {
        await fetchSnapshot(targetId, { signal: options.signal, apply, force: true })
      } finally {
        if (showSpinner && !options.signal?.aborted) {
          setLoadingSnapshot(false)
        }
      }
    },
    [orderId, fetchSnapshot]
  )

  const selectOrder = useCallback(
    (id: string) => {
      if (!id) return
      setLastVisitedOrderId(id)

      if (id === orderId) {
        void ensureSnapshotFresh(id, { apply: true })
        return
      }

      const previous = orderId
      if (previous && previous !== id) {
        void ensureSnapshotFresh(previous, { apply: false, showSpinner: false })
      }

      const cached = contextCacheRef.current.get(id) ?? null
      const needsForce = !cached || snapshotExpiresSoon(cached)
      if (cached) {
        applySnapshotToState(id, cached, { source: 'cache', force: true })
      } else {
        applySnapshotToState(id, null, { source: 'reset', force: true })
      }
      setLoadingSnapshot(needsForce)
      setOrderId(id)
      void ensureSnapshotFresh(id, { force: needsForce, apply: true, showSpinner: needsForce })
    },
    [orderId, applySnapshotToState, ensureSnapshotFresh]
  )

  const startNewOrder = useCallback<WorkspaceContextValue['startNewOrder']>(async () => {
    if (creatingOrderRef.current) return
    creatingOrderRef.current = true
    // Proactively clear warm cache for current order (visual reset safety)
    try { if (orderId) { window.sessionStorage.removeItem(`replicator:ss:${orderId}`); window.localStorage.removeItem(`${SIZE_STORAGE_PREFIX}${orderId}`) } } catch {}
    let spinnerActive = false
    let pendingFetches = 0

    const ensureSpinnerOn = () => {
      if (!spinnerActive) {
        setLoadingSnapshot(true)
        spinnerActive = true
      }
    }
    const ensureSpinnerOff = () => {
      if (spinnerActive && pendingFetches === 0) {
        setLoadingSnapshot(false)
        spinnerActive = false
      }
    }
    const beginFetchWithSpinner = () => {
      pendingFetches += 1
      ensureSpinnerOn()
    }
    const endFetchWithSpinner = () => {
      pendingFetches = Math.max(0, pendingFetches - 1)
      ensureSpinnerOff()
    }

    const loadSnapshotForReuse = async (id: string): Promise<ContextSnapshot | null> => {
      if (!id) return null
      let snap = contextCacheRef.current.get(id) ?? null
      if (snap && !snapshotExpiresSoon(snap, 15_000)) {
        return snap
      }
      try {
        beginFetchWithSpinner()
        const needsForce = !snap || snapshotExpiresSoon(snap)
        snap = await fetchSnapshot(id, { force: needsForce, apply: false })
        if (snap) {
          contextCacheRef.current.set(id, snap)
        }
        return snap
      } catch (err) {
        console.warn('[Workspace] failed to load snapshot for reuse', err)
        return snap ?? null
      } finally {
        endFetchWithSpinner()
      }
    }

    const isOrderStatusNew = (status?: string | null) => {
      if (!status) return false
      return status.toLowerCase() === 'new'
    }

    const sessionStatusMap = new Map<string, string | null | undefined>()
    for (const entry of sessions) {
      if (entry?.id) {
        sessionStatusMap.set(entry.id, entry.status)
      }
    }

    try {
      const currentId = orderId
      if (currentId) {
        const status = sessionStatusMap.get(currentId)
        let snap = contextCacheRef.current.get(currentId) ?? null
        if (!snap && isOrderStatusNew(status)) {
          snap = await loadSnapshotForReuse(currentId)
        }
        if (snapshotIsPristine(snap)) {
          applySnapshotToState(currentId, snap, { source: 'reset', force: true })
          if (typeof window !== 'undefined') {
            try {
              window.localStorage.removeItem(`${SIZE_STORAGE_PREFIX}${currentId}`)
            } catch {}
          }
          setOrderRevision((value) => value + 1)
          ensureSpinnerOff()
          return
        }
      }

      // Always create a brand-new project; skip reusing an existing 'new' order

      const token = await getAccessToken()
      if (!token) {
        ensureSpinnerOff()
        return
      }

      const result = await createOrder('')
      const newOrderId = result?.order_id
      if (!newOrderId) {
        ensureSpinnerOff()
        return
      }
      const seedSnapshot: ContextSnapshot = {
        orderId: newOrderId,
        status: 'new',
        images: [],
        messages: [],
        fetched_at: Date.now(),
      }
      contextCacheRef.current.set(newOrderId, seedSnapshot)
      applySnapshotToState(newOrderId, seedSnapshot, { source: 'reset', force: true })
      setOrderId(newOrderId)
      setLastVisitedOrderId(newOrderId)
      setOrderRevision((value) => value + 1)
      // Do not list drafts in the sidebar until first activity; rely on first_activity_at filter
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(LAST_ORDER_STORAGE_KEY, newOrderId)
        } catch {}
      }
      refreshSessions().catch(() => {})
      void ensureSnapshotFresh(newOrderId, { apply: true, force: false, showSpinner: false })
    } catch (err) {
      console.warn('[Workspace] failed to start new order', err)
    } finally {
      pendingFetches = 0
      ensureSpinnerOff()
      creatingOrderRef.current = false
    }
  }, [orderId, sessions, applySnapshotToState, ensureSnapshotFresh, fetchSnapshot, refreshSessions])

  // Clear warm cache for current order before starting a brand-new project to avoid any visual carryover
  const clearWarmCacheForOrder = useCallback((id: string | null) => {
    if (typeof window === 'undefined') return
    if (!id) return
    try {
      window.sessionStorage.removeItem(`replicator:ss:${id}`)
      window.localStorage.removeItem(`${SIZE_STORAGE_PREFIX}${id}`)
    } catch {}
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const stored = window.localStorage.getItem(LAST_ORDER_STORAGE_KEY)
      if (stored) {
        setLastVisitedOrderId(stored)
        setOrderId((current) => current ?? stored)
      }
    } catch {}
  }, [])

  useEffect(() => {
    let active = true
    refreshSessions().then(() => {
      if (!active) return
    })
    return () => {
      active = false
    }
  }, [refreshSessions])

  useEffect(() => {
    if (!orderId) return
    refreshSessions().catch(() => {})
  }, [orderId, refreshSessions])

  useEffect(() => {
    const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
      if (!session?.user) {
        setSessions([])
        resetWorkspace(orderId ?? undefined)
        contextCacheRef.current.clear()
        return
      }
      refreshSessions().catch(() => {})
    })
    return () => {
      sub.subscription.unsubscribe()
    }
  }, [orderId, refreshSessions, resetWorkspace])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (orderId) {
        window.localStorage.setItem(LAST_ORDER_STORAGE_KEY, orderId)
      } else {
        window.localStorage.removeItem(LAST_ORDER_STORAGE_KEY)
      }
    } catch {}
  }, [orderId])

  useEffect(() => {
    activeOrderIdRef.current = orderId
  }, [orderId])

  useEffect(() => {
    if (!orderId) {
      snapshotAbortRef.current?.abort()
      setInitialMessages(null)
      setInitialStatus(null)
      setLocalPreview(null)
      setLoadingSnapshot(false)
      return
    }

    let cached = contextCacheRef.current.get(orderId) ?? null
    // Warm-cache: try sessionStorage snapshot for instant rehydrate (guarded by orderId + owner)
    const tryLoadWarm = async (): Promise<ContextSnapshot | null> => {
      if (typeof window === 'undefined') return null
      try {
        const raw = window.sessionStorage.getItem(`replicator:ss:${orderId}`)
        if (!raw) return null
        const snap = JSON.parse(raw) as ContextSnapshot & { owner_user_id?: string | null }
        if (!snap || (snap as any)?.orderId !== orderId) return null
        try {
          const { data: { user: me } } = await supabaseBrowser.auth.getUser()
          if (!me?.id || (snap as any)?.owner_user_id !== me.id) return null
        } catch {
          return null
        }
        return snap
      } catch {
        return null
      }
    }
    if (cached) {
      applySnapshotToState(orderId, cached, { source: 'cache' })
    } else {
      applySnapshotToState(orderId, null, { source: 'reset' })
      ;(async () => {
        const warm = await tryLoadWarm()
        if (warm) {
          contextCacheRef.current.set(orderId, warm)
          applySnapshotToState(orderId, warm, { source: 'cache' })
        }
      })().catch(() => null)
    }

    const controller = new AbortController()
    snapshotAbortRef.current?.abort()
    snapshotAbortRef.current = controller

    const needsForce = !cached || snapshotExpiresSoon(cached)
    setLoadingSnapshot(needsForce)
    ensureSnapshotFresh(orderId, {
      force: needsForce,
      apply: true,
      showSpinner: needsForce,
      signal: controller.signal,
    }).catch((err) => {
      if (!controller.signal.aborted) {
        console.warn('[Workspace] ensureSnapshotFresh failed', err)
      }
    })

    return () => {
      controller.abort()
    }
  }, [orderId, applySnapshotToState, ensureSnapshotFresh])

  // Prefetch STL bytes to persistent Cache Storage keyed by canonical storage_url
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = localPreview?.url || null
    const storageUrl = localPreview?.storageUrl || null
    if (!url || !storageUrl) return
    let cancelled = false
    ;(async () => {
      try {
        // @ts-ignore
        if (!('caches' in window)) return
        const cache = await caches.open('replicator-stl-v1')
        const req = new Request(storageUrl, { method: 'GET' })
        const already = await cache.match(req)
        if (already) return
        const res = await fetch(url, { cache: 'reload' })
        if (!res.ok) return
        const buf = await res.arrayBuffer()
        if (cancelled) return
        const put = new Response(buf, { headers: { 'Content-Type': 'application/sla', 'Cache-Control': 'public, max-age=31536000, immutable' } })
        await cache.put(req, put)
        // Record LRU and prune (limit 12)
        try {
          const raw = window.localStorage.getItem('replicator:stl:lru')
          const m = raw ? (JSON.parse(raw) as Record<string, number>) : {}
          m[storageUrl] = Date.now()
          window.localStorage.setItem('replicator:stl:lru', JSON.stringify(m))
          const keys = await cache.keys()
          const limit = 12
          if (keys.length > limit) {
            const entries = keys.map((k) => ({ url: k.url, at: Number(m[k.url] || 0) }))
            entries.sort((a, b) => a.at - b.at)
            const toDelete = entries.slice(0, Math.max(0, entries.length - limit))
            for (const e of toDelete) {
              try { await cache.delete(e.url) } catch {}
              delete m[e.url]
            }
            window.localStorage.setItem('replicator:stl:lru', JSON.stringify(m))
          }
        } catch {}
      } catch {
        // ignore
      }
    })()
    return () => { cancelled = true }
  }, [localPreview?.url, localPreview?.storageUrl])

  // Global hard-stop on refresh: cancel order + abort pending fetches
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handleBeforeUnload = () => {
      const id = activeOrderIdRef.current
      if (!id) return
      try {
        const payload = JSON.stringify({ reason: 'refresh' })
        const url = `${window.location.origin}/api/orders/${id}/cancel`
        // Try beacon first for reliability
        const ok = (window.navigator as any)?.sendBeacon?.(url, new Blob([payload], { type: 'application/json' }))
        if (!ok) {
          // Fallback: keepalive fetch; errors are ignored on unload
          try {
            fetch(`/api/orders/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true })
          } catch {}
        }
      } catch {}
      try { snapshotAbortRef.current?.abort() } catch {}
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!orderId) return
    const interval = window.setInterval(() => {
      void ensureSnapshotFresh(orderId, { apply: true, showSpinner: false })
    }, 60_000)
    return () => {
      window.clearInterval(interval)
    }
  }, [orderId, ensureSnapshotFresh])

  // React to first-activity hints from ChatPanel (chat/upload) and refresh sessions
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => { refreshSessions().catch(() => {}) }
    window.addEventListener('workspace:first-activity', handler as any)
    return () => { window.removeEventListener('workspace:first-activity', handler as any) }
  }, [refreshSessions])

  // Cross-tab/project broadcasts: react to deletions
  useEffect(() => {
    if (typeof window === 'undefined') return
    let bc: BroadcastChannel | null = null
    try {
      bc = new BroadcastChannel('replicator:orders')
      bc.onmessage = (ev) => {
        const msg = ev?.data || {}
        if (!msg || typeof msg !== 'object') return
        if (msg.type === 'order.deleted' && typeof msg.id === 'string') {
          const deletedId: string = msg.id
          setSessions((prev) => prev.filter((s) => s.id !== deletedId))
          if (deletedId === orderId) {
            // Reset local workspace if the active order was deleted in this or another tab
            resetWorkspace(orderId)
          }
        }
      }
    } catch {}
    return () => { try { bc?.close() } catch {} }
  }, [orderId, resetWorkspace])

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      orderId,
      lastVisitedOrderId,
      orderRevision,
      sessions,
      loadingSnapshot,
      initialMessages,
      initialStatus,
      initialAttachments,
      localPreview,
      selectOrder,
      startNewOrder,
      handleOrderCreated,
      handleViewerFocus,
      resetWorkspace,
      refreshSessions,
      ensureSnapshotFresh,
    }),
    [
      orderId,
      lastVisitedOrderId,
      orderRevision,
      sessions,
      loadingSnapshot,
      initialMessages,
      initialStatus,
      initialAttachments,
      localPreview,
      selectOrder,
      startNewOrder,
      handleOrderCreated,
      handleViewerFocus,
      resetWorkspace,
      refreshSessions,
      ensureSnapshotFresh,
    ]
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext)
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider')
  }
  return context
}
