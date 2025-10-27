"use client"
import React, { useEffect, useRef, useState, useCallback, useMemo } from "react"
import QuoteCard from "@/components/QuoteCard"
import { createCheckout, getOrder } from "@/lib/api"
import { createOrder } from "@/lib/api"
import { authedFetch, getAccessToken, onAccessTokenChange } from "@/lib/clientAuth"
import CommandInput from "@/components/CommandInput"
import AuthModal from "@/components/AuthModal"
import { supabaseBrowser } from "@/lib/supabaseClient"
import { useOrderState, useOrderStateActions } from "@/components/OrderScope"

type ViewerFocusKind = 'stl' | 'glb' | 'gltf' | 'obj' | 'toolpath'
type ViewerFocusMeta = { assetId?: string | null; createdAt?: string | number | null; storageUrl?: string | null; expiresAt?: number | null; metrics?: any }
type HistoryMessage = { id: string; role: 'user'|'assistant'|'tool'; type?: string | null; content?: any; created_at?: string | null }
type ChatPanelProps = {
  orderId?: string | null
  title?: string
  loadingSnapshot?: boolean
  initialMessages?: HistoryMessage[] | null
  initialStatus?: string | null
  initialAttachments?: AttachmentItem[] | null
  onOrderCreated?: (id: string)=>void
  onViewerFocus?: (kind: ViewerFocusKind, url: string, assetKind?: string | null, meta?: ViewerFocusMeta)=>void
  variant?: 'classic'|'device'
}
type Msg = { role: 'user'|'assistant'; text?: string; kind?: 'log'|'quote' }

type AttachmentItem = {
  assetId: string
  url: string
  storageUrl?: string | null
  expiresAt?: number | null
  label?: string | null
  pending?: boolean
  name?: string | null
  size?: number | null
  contentType?: string | null
}

const IMAGE_FILE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif', '.svg']

function isImageFileLike(file: File | null | undefined) {
  if (!file) return false
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('image/')) return true
  const name = (file.name || '').toLowerCase()
  return IMAGE_FILE_EXTS.some((ext) => name.endsWith(ext))
}

function dataTransferHasImage(dt: DataTransfer | null) {
  if (!dt) return false
  try {
    if (dt.items && dt.items.length) {
      for (const item of Array.from(dt.items)) {
        if (!item || item.kind !== 'file') continue
        const type = (item.type || '').toLowerCase()
        if (type.startsWith('image/')) return true
        if (!type || type === 'application/octet-stream') {
          const file = item.getAsFile()
          if (isImageFileLike(file)) return true
        }
      }
    }
  } catch {}
  const files = dt.files
  if (files && files.length) {
    for (const file of Array.from(files)) {
      if (isImageFileLike(file)) return true
    }
  }
  return false
}

function normalizeAttachments(raw: any): AttachmentItem[] {
  const list = Array.isArray(raw) ? raw : []
  const result: AttachmentItem[] = []
  for (const entry of list) {
    const assetId = typeof entry?.asset_id === 'string' ? entry.asset_id : typeof entry?.assetId === 'string' ? entry.assetId : null
    const url = typeof entry?.url === 'string' ? entry.url : null
    if (!assetId || !url) continue
    result.push({
      assetId,
      url,
      storageUrl: entry?.storage_url ?? entry?.storageUrl ?? null,
      expiresAt: typeof entry?.expires_at === 'number' ? entry.expires_at : entry?.expiresAt ?? null,
      label: typeof entry?.label === 'string' ? entry.label : null,
      pending: entry?.pending === undefined ? undefined : Boolean(entry.pending),
      name: typeof entry?.name === 'string' ? entry.name : null,
      size: typeof entry?.size === 'number' ? entry.size : null,
      contentType: typeof entry?.content_type === 'string' ? entry.content_type : entry?.contentType ?? null,
    })
  }
  return result
}

export default function ChatPanel(_props: ChatPanelProps) {
  const { status } = useOrderState()
  const { applyServerUpdate } = useOrderStateActions()
  const [phase, setPhase] = useState<'Specify'|'Visualize'|'Materialize'>('Specify')
  // Atom availability indicator removed per request
  const [messages, setMessages] = useState<Msg[]>([])
  const [attachments, setAttachments] = useState<AttachmentItem[]>(() => normalizeAttachments(_props.initialAttachments))
  const [orderId, setOrderId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [materializeStage, setMaterializeStage] = useState<'draft'|null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const sseRef = useRef<any | null>(null)
  // Multi-tab leadership coordination per order
  const bcRef = useRef<BroadcastChannel | null>(null)
  const tabIdRef = useRef<string>(`tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
  const roleRef = useRef<'leader' | 'follower' | null>(null)
  const leaderIdRef = useRef<string | null>(null)
  const hbIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hbMissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const electionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track which parent image ids already have a final angles card rendered
  const anglesRenderedRef = useRef<Set<string>>(new Set())
  // Track which parent image ids are currently generating angles (for spinner + skeleton)
  const [anglesLoading, setAnglesLoading] = useState<Set<string>>(new Set())
  // Track bulk materialize clicks on an angles card (keyed by parent image id)
  const [anglesBatchInflight, setAnglesBatchInflight] = useState<Set<string>>(new Set())
  // (Removed timeout guard for angles — per user request)
  // Track which cards are remixing (per-card animation)
  const [remixingIds, setRemixingIds] = useState<Set<string>>(new Set())
  function addRemixing(id: string) { setRemixingIds(prev => { const next = new Set(prev); next.add(id); return next }) }
  function clearRemixing(id: string) { setRemixingIds(prev => { const next = new Set(prev); next.delete(id); return next }) }
  function newLocalId() { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }
  const streamingRef = useRef<boolean>(false)
  const seenMsgIdsRef = useRef<Set<string>>(new Set())
  const chatPaintMeasuredRef = useRef<boolean>(false)
  const historyPrimedRef = useRef<boolean>(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  // Track last asset id we focused to avoid duplicate viewer updates
  const lastFocusAssetIdRef = useRef<string | null>(null)
  const historyAppliedOrderRef = useRef<string | null>(null)
  const processAssistantEventRef = useRef<(evt: any, source?: 'stream' | 'history' | 'channel') => void>(() => {})
  // Worker health tracking: start when materialization begins, warn if no progress
  const jobStartAtRef = useRef<number | null>(null)
  const workerWarnedRef = useRef<boolean>(false)
  const focusKinds: ViewerFocusKind[] = ['stl','glb','gltf','obj','toolpath']
  const derivePhaseFromStatus = useCallback((status?: string | null) => {
    if (!status) return 'Specify'
    const norm = status.toLowerCase()
    if (norm.includes('visual') || norm === 'concept') return 'Visualize'
    return 'Materialize'
  }, [])
  // Per-image UI state for modeling start
  const [inflightIds, setInflightIds] = useState<Set<string>>(new Set())
  const [materializingIds, setMaterializingIds] = useState<Set<string>>(new Set())
  const authPromptedRef = useRef<boolean>(false)
  const [tokenVersion, setTokenVersion] = useState<number>(0)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  
  const [showProbe, setShowProbe] = useState<boolean>(false)
  const [remixing, setRemixing] = useState<boolean>(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const pendingUserMessageRef = useRef<string | null>(null)
  const optimisticUserQueueRef = useRef<string[]>([])
  // Track dismissed quotes by hash (per order)
  const [dismissedQuotes, setDismissedQuotes] = useState<Set<string>>(new Set())
  // Inline edit target (selected concept image)
  const [editTarget, setEditTarget] = useState<{ id: string; url: string } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const brokenImagesRef = useRef<Set<string>>(new Set())
  const [imageDragActive, setImageDragActive] = useState<boolean>(false)
  const imageDragDepthRef = useRef<number>(0)
  const { onOrderCreated } = _props

  // Revalidate order snapshot when the tab becomes visible to keep shared state fresh
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVis = async () => {
      if (document.visibilityState === 'visible' && orderId) {
        try {
          const snap = await getOrder(orderId)
          const status = (snap?.order?.status || '') as string
          const versionRaw = snap?.order?.version
          const version = typeof versionRaw === 'number' ? versionRaw : Number(versionRaw)
          applyServerUpdate({
            status: status || null,
            orderVersion: Number.isFinite(version) ? version : undefined,
            quote: snap?.order?.quote_json ?? null,
          })
        } catch {}
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [orderId, applyServerUpdate])

  useEffect(() => {
    setAttachments(normalizeAttachments(_props.initialAttachments))
  }, [_props.initialAttachments])

  // Debug: expose helper state to window for quick inspection
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        ;(window as any).__fabricatorHelper = {
          messagesLen: messages.length,
          streaming,
          loadingSnapshot: _props.loadingSnapshot ?? null,
          orderId,
        }
      }
    } catch {}
  }, [messages.length, streaming, _props.loadingSnapshot, orderId])

  // Debug: enable a visible probe when ?probe=1 is present
  useEffect(() => {
    try {
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search)
        setShowProbe(params.get('probe') === '1')
      }
    } catch {}
  }, [])

  useEffect(() => {
    if (attachments.length && phase === 'Specify') {
      setPhase('Visualize')
    }
  }, [attachments, phase])

  const updateAttachmentsState = useCallback((payload: any, opts?: { replace?: boolean }) => {
    const list = normalizeAttachments(payload?.attachments ?? payload)
    if (opts?.replace) {
      setAttachments(list)
      return
    }
    if (!list.length) return
    setAttachments((prev) => {
      const map = new Map<string, AttachmentItem>()
      for (const item of prev) {
        map.set(item.assetId, item)
      }
      for (const item of list) {
        map.set(item.assetId, { ...map.get(item.assetId), ...item })
      }
      return Array.from(map.values())
    })
  }, [])

  useEffect(() => {
    if (!orderId) return
    if (typeof window === 'undefined') return
    const handleAtomLog = (event: Event) => {
      try {
        const detail = (event as CustomEvent<{ orderId?: string; text?: string }>).detail
        if (!detail || detail.orderId !== orderId) return
        const text = typeof detail.text === 'string' ? detail.text.trim() : ''
        if (!text) return
        setMessages((prev) => [...prev, { role: 'assistant', kind: 'log', text }])
      } catch (err) {
        console.warn('[ChatPanel] atom log handler failed', err)
      }
    }
    window.addEventListener('fabricator:atom-log', handleAtomLog as EventListener)
    return () => {
      window.removeEventListener('fabricator:atom-log', handleAtomLog as EventListener)
    }
  }, [orderId])

  useEffect(() => {
    const resetDrag = () => {
      imageDragDepthRef.current = 0
      setImageDragActive(false)
    }
    window.addEventListener('dragend', resetDrag)
    window.addEventListener('drop', resetDrag)
    return () => {
      window.removeEventListener('dragend', resetDrag)
      window.removeEventListener('drop', resetDrag)
    }
  }, [])

  // Derive a stable quote hash for dismissal and change-detection
  const computeQuoteHash = useCallback((q: any) => {
    try {
      if (!q || typeof q !== 'object') return null
      const total = (q.total_cents ?? q.price_cents)
      const grams = q.grams
      const minutes = q.minutes
      if (typeof total !== 'number') return null
      const g = Number.isFinite(Number(grams)) ? Number(grams) : 'x'
      const m = Number.isFinite(Number(minutes)) ? Number(minutes) : 'x'
      return `${total}_${g}_${m}`
    } catch { return null }
  }, [])

  // Helper to mark a quote hash as dismissed and persist to localStorage
  const dismissQuoteHash = useCallback((hash: string | null) => {
    if (!hash) return
    setDismissedQuotes((prev) => { const next = new Set(prev); next.add(hash); return next })
    try { if (orderId) localStorage.setItem(`quote_dismissed:${orderId}:${hash}`, 'true') } catch {}
  }, [orderId])

  function addInflight(id: string) {
    setInflightIds((prev) => { const next = new Set(prev); next.add(id); return next })
  }
  function clearInflight(id: string) {
    setInflightIds((prev) => { const next = new Set(prev); next.delete(id); return next })
  }
  function addMaterializing(ids: string[]) {
    if (!ids || !ids.length) return
    setMaterializingIds((prev) => { const next = new Set(prev); for (const i of ids) next.add(i); return next })
  }
  function clearMaterializing(ids?: string[]) {
    if (!ids) { setMaterializingIds(new Set()); return }
    setMaterializingIds((prev) => { const next = new Set(prev); for (const i of ids) next.delete(i); return next })
  }

  const removeAttachment = useCallback((assetId: string) => {
    if (!assetId) return
    setAttachments((prev) => prev.filter((item) => item.assetId !== assetId))
  }, [])

  function applyMaterializeStage(stageValue?: string | null) {
    if (!stageValue || typeof stageValue !== 'string') return
    const norm = stageValue.trim().toLowerCase()
    if (norm === 'draft' || norm === 'refine' || norm === 'high') {
      setMaterializeStage('draft')
    }
  }

  function formatBytesShort(bytes?: number | null): string | null {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${bytes.toFixed(0)} B`
  }

  function formatBoundingBox(bbox: any): string | null {
    if (!bbox || typeof bbox !== 'object') return null
    const x = Number((bbox as any).x)
    const y = Number((bbox as any).y)
    const z = Number((bbox as any).z)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
    return `${Math.round(x)} × ${Math.round(y)} × ${Math.round(z)} mm`
  }

  function pushMeshCard(payload: any) {
    if (!payload || typeof payload !== 'object') return
    const orientation = payload?.orientation && typeof payload.orientation === 'object' ? payload.orientation : null
    const sliceCheck = payload?.slice_check && typeof payload.slice_check === 'object' ? payload.slice_check : null
    const sizeBytes = Number(payload?.size_bytes)
    const floatingCount = Number(payload?.floating_component_count)
    const status = typeof payload?.status === 'string' ? payload.status : null
    const parts: string[] = []
    if (orientation && typeof orientation === 'object') {
      const bbox = (orientation as any).bbox_mm
      if (bbox && typeof bbox === 'object') {
        const sx = Number((bbox as any).x)
        const sy = Number((bbox as any).y)
        const sz = Number((bbox as any).z)
        if (Number.isFinite(sx) && Number.isFinite(sy) && Number.isFinite(sz)) {
          parts.push(`size ${Math.round(sx)} × ${Math.round(sy)} × ${Math.round(sz)} mm`)
        }
      }
    }
    if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
      parts.push(`file ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`)
    }
    if (sliceCheck && typeof sliceCheck === 'object') {
      const st = String(sliceCheck.status || '')
      if (st.toLowerCase() === 'ok') {
        const mins = Number(sliceCheck.minutes)
        const grams = Number(sliceCheck.grams)
        const detail: string[] = ['validation passed']
        if (Number.isFinite(mins)) detail.push(`${Math.round(mins)} min`)
        if (Number.isFinite(grams)) detail.push(`${Math.round(grams)} g`)
        parts.push(detail.join(' · '))
      }
    }
    if (Number.isFinite(floatingCount) && Number(floatingCount) > 0) {
      parts.push(`floating regions ${Number(floatingCount)}`)
    }
    if (status && status.toLowerCase().includes('ready')) {
      parts.push('print-ready')
    }
    const text = parts.length ? `Mesh update — ${parts.join(' · ')}.` : 'Mesh update ready.'
    setMessages((prev) => [...prev, { id: newLocalId(), role: 'assistant', kind: 'log', text } as any])
    setPhase('Materialize')
    clearMaterializing()
  }

  const maybePromptAuth = useCallback((text = 'Sign in to continue.') => {
    if (authPromptedRef.current) return
    authPromptedRef.current = true
    setAuthModalOpen(true)
  }, [])

  const handleAuthSuccess = useCallback((userId: string) => {
    setAuthModalOpen(false)
    authPromptedRef.current = false
    setTokenVersion(v => v + 1)
    // Retry pending message if user was mid-send
    if (pendingUserMessageRef.current) {
      const pending = pendingUserMessageRef.current
      pendingUserMessageRef.current = null
      void send(pending)
    }
  }, [])

  const ensureAuthenticated = useCallback(async () => {
    const token = await getAccessToken()
    if (!token) {
      maybePromptAuth('Sign in to start a job (orders are tied to your account).')
      return false
    }
    // Validate token is still valid by checking with Supabase
    try {
      const { data, error } = await supabaseBrowser.auth.getUser()
      if (error || !data?.user) {
        // Token is invalid - clear it and prompt auth
        await supabaseBrowser.auth.signOut()
        maybePromptAuth('Your session expired. Please sign in again.')
        return false
      }
      return true
    } catch (e) {
      // Network error or other issue - clear session to be safe
      await supabaseBrowser.auth.signOut()
      maybePromptAuth('Authentication error. Please sign in again.')
      return false
    }
  }, [maybePromptAuth])

  const authedFetchSafe = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await authedFetch(input, init)
    } catch (err: any) {
      if (String(err?.message || '').includes('not_authenticated')) {
        maybePromptAuth()
      }
      throw err
    }
  }, [maybePromptAuth])

  const refreshImageUrl = useCallback(
    async (imageId: string, storageUrl?: string | null) => {
      if (!orderId) return
      const cacheKey = `${imageId || 'missing'}:${storageUrl || 'missing'}`
      if (brokenImagesRef.current.has(cacheKey)) return
      brokenImagesRef.current.add(cacheKey)
      try {
        const res = await authedFetchSafe('/api/storage/sign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId,
            images: [{ id: imageId, url: storageUrl ?? undefined }],
          }),
        })
        if (!res.ok) return
        const payload = await res.json().catch(() => null)
        const entry = Array.isArray(payload?.results)
          ? payload.results.find((item: any) => (imageId && item?.id === imageId) || (!imageId && item?.storage_url === storageUrl))
          : null
        if (!entry || !entry.url) return
        const nextStorageUrl = entry.storage_url ?? storageUrl ?? null
        const nextExpires = entry.expires_at ?? null
        setMessages((ms) =>
          ms.map((msg: any) => {
            if (!msg) return msg
            if (msg.kind === 'images' && Array.isArray(msg.images)) {
              const updated = msg.images.map((img: any) =>
                img?.id === imageId
                  ? { ...img, url: entry.url, storage_url: nextStorageUrl, expires_at: nextExpires }
                  : img,
              )
              return { ...msg, images: updated }
            }
            if (Array.isArray(msg.groups)) {
              const updatedGroups = msg.groups.map((group: any) => ({
                ...group,
                images: Array.isArray(group.images)
                  ? group.images.map((img: any) =>
                      img?.id === imageId
                        ? { ...img, url: entry.url, storage_url: nextStorageUrl, expires_at: nextExpires }
                        : img,
                    )
                  : group.images,
              }))
              return { ...msg, groups: updatedGroups }
            }
            return msg
          }),
        )
      } catch (err) {
        console.warn('[ChatPanel] failed to refresh image URL', err)
      }
    },
    [authedFetchSafe, orderId],
  )

  // Allow closing image preview with ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewUrl(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    return onAccessTokenChange((token) => {
      if (token) authPromptedRef.current = false
      setTokenVersion((v) => v + 1)
    })
  }, [])

  useEffect(() => {
    if (typeof _props.orderId === 'string' && _props.orderId) {
      if (_props.orderId !== orderId) {
        setOrderId(_props.orderId)
      }
    } else if (!_props.orderId && orderId) {
      setOrderId(null)
      setPhase('Specify')
      setMaterializeStage(null)
      setMessages([])
      setAttachments([])
      setInflightIds(new Set())
      setMaterializingIds(new Set())
      setAnglesLoading(new Set())
      setAnglesBatchInflight(new Set())
      setRemixingIds(new Set())
      anglesRenderedRef.current = new Set()
      seenMsgIdsRef.current = new Set()
      lastFocusAssetIdRef.current = null
      jobStartAtRef.current = null
      workerWarnedRef.current = false
      historyAppliedOrderRef.current = null
      // Tear down multi-tab channel on order clear
      try { if (electionTimerRef.current) clearTimeout(electionTimerRef.current) } catch {}
      try { if (hbIntervalRef.current) clearInterval(hbIntervalRef.current) } catch {}
      try { if (hbMissTimerRef.current) clearTimeout(hbMissTimerRef.current) } catch {}
      try { bcRef.current?.close?.() } catch {}
      bcRef.current = null
      roleRef.current = null
      leaderIdRef.current = null
    }
  }, [_props.orderId, orderId])

  const ensureOrder = useCallback(
    async (prompt: string): Promise<string | null> => {
      if (orderId) return orderId
      const authed = await ensureAuthenticated()
      if (!authed) return null
      try {
        const res = await createOrder(prompt)
        setOrderId(res.order_id)
        setMaterializeStage(null)
        onOrderCreated?.(res.order_id)
        return res.order_id
      } catch (e: any) {
        if (typeof e?.status === 'number' && e.status === 401) {
          maybePromptAuth('Sign in to start a job (orders are tied to your account).')
          return null
        }
        setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'Failed to create order' }])
        return null
      }
    },
    [
      orderId,
      ensureAuthenticated,
      setOrderId,
      setMaterializeStage,
      onOrderCreated,
      maybePromptAuth,
      setMessages,
    ],
  )

  const handleUpload = useCallback(
    async (files: FileList | File[] | null) => {
      const list = Array.isArray(files) ? files : files ? Array.from(files) : []
      if (!list.length) return
      const imageFiles = list.filter((file) => isImageFileLike(file))
      if (!imageFiles.length) return
      let oid = orderId
      if (!oid) {
        oid = await ensureOrder('upload')
      }
      if (!oid) return
      try {
        const fd = new FormData()
        fd.append('orderId', oid)
        imageFiles.forEach((file) => fd.append('file', file))
        const res = await authedFetchSafe('/api/chat/upload', { method: 'POST', body: fd })
        if (!res.ok) {
          let msg = 'upload failed'
          try {
            const payload = await res.json()
            if (payload?.error) msg = payload.error
          } catch {}
          setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: msg }])
          return
        }
        const payload = await res.json().catch(() => null)
        if (payload && typeof payload === 'object') updateAttachmentsState(payload)
        setPhase('Visualize')
        try { window.dispatchEvent(new CustomEvent('workspace:first-activity', { detail: { orderId: oid } })) } catch {}
      } catch (e: any) {
        if (!String(e?.message || '').includes('not_authenticated')) {
          setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'upload failed' }])
        }
      }
    },
    [orderId, ensureOrder, authedFetchSafe, setMessages, setPhase, updateAttachmentsState],
  )

  const handleConsoleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(e.dataTransfer ?? null)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      imageDragDepthRef.current += 1
      setImageDragActive(true)
    },
    [],
  )

  const handleConsoleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(e.dataTransfer ?? null)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    },
    [],
  )

  const handleConsoleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(e.dataTransfer ?? null)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      imageDragDepthRef.current = Math.max(0, imageDragDepthRef.current - 1)
      if (imageDragDepthRef.current === 0) {
        setImageDragActive(false)
      }
    },
    [],
  )

  const handleConsoleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!dataTransferHasImage(e.dataTransfer ?? null)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      imageDragDepthRef.current = 0
      setImageDragActive(false)
      const files = e.dataTransfer?.files
      if (!files || !files.length) return
      const imageFiles = Array.from(files).filter((file) => isImageFileLike(file))
      if (!imageFiles.length) return
      void handleUpload(imageFiles)
    },
    [handleUpload],
  )

  async function send(txt: string) {
    const text = (txt || '').trim()
    if (!text) return
    const creatingOrder = !orderId
    if (creatingOrder) pendingUserMessageRef.current = text
    setMessages((m) => [...m, { role: 'user', text }])
    // If we have an order, call chat SSE; else try to create order
    let oid = orderId
    if (!oid) {
      oid = await ensureOrder(text)
    }

    
    if (!oid) return
    if (!creatingOrder) pendingUserMessageRef.current = null
    optimisticUserQueueRef.current.push(text)
    // If editing a specific concept, route to /api/edit directly
    if (editTarget) {
      try {
        const res = await authedFetchSafe('/api/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: oid, imageId: editTarget.id, prompt: text, n: 2 }),
        })
        if (!res.ok) {
          let msg = 'edit failed'
          try { const d = await res.json(); if (d?.error) msg = d.error } catch {}
          setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: msg }])
          return
        }
        setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: 'Editing concept…' }])
        setPhase('Visualize')
      } catch (e:any) {
        if (String(e?.message || '').includes('not_authenticated')) return
        setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'edit failed' }])
      } finally {
        setEditTarget(null)
      }
      return
    }
    setStreaming(true); streamingRef.current = true
    const ac = new AbortController(); abortRef.current = ac
    try {
      const res = await authedFetchSafe('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: oid, message: text }),
        signal: ac.signal,
      })
      if (!res.ok) throw new Error(await res.text().catch(() => 'chat failed'))
      try { window.dispatchEvent(new CustomEvent('workspace:first-activity', { detail: { orderId: oid } })) } catch {}
      // We rely on the persistent SSE stream for updates to avoid duplicates.
      if (!res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const parts = chunk.split('\n\n').map(s => s.trim()).filter(Boolean)
        for (const p of parts) {
          if (!p.startsWith('data:')) continue
          const json = p.slice(5).trim()
          try {
            const evt = JSON.parse(json)
            // If an order_id is present and does not match current order, drop it
            try { if (evt?.order_id && orderId && evt.order_id !== orderId) continue } catch {}
            if (evt.id && seenMsgIdsRef.current.has(evt.id)) {
              continue
            } else if (evt.id) {
              seenMsgIdsRef.current.add(evt.id)
            }
            if (evt.role === 'assistant') {
              if (evt.type === 'card.images') {
                const groups = Array.isArray(evt.content?.groups) ? evt.content.groups : null
                const imgs = Array.isArray(evt.content?.images) ? evt.content.images : []
                const prompt = evt.content?.prompt || ''
                const style = evt.content?.style || null
                if (groups && groups.length) {
                  setMessages((m) => [...m, { id: newLocalId(), role: 'assistant', kind: 'images', groups } as any])
                } else {
                  // Legacy single-image grid fallback, but preserve group tag when present (e.g., angles)
                  const group = evt.content?.group || null
                  if (group === 'angles') {
                    const parent = evt.content?.parent_image_id || ''
                    if (parent) {
                      // If we already showed angles via immediate JSON, skip SSE duplicate
                      if (anglesRenderedRef.current.has(parent)) return
                      // Otherwise, replace any existing angles or skeleton for this parent
                      setMessages((m) =>
                        m.filter(
                          (x: any) =>
                            !(
                              (x?.kind === 'images' && x?.group === 'angles' && x?.parentId === parent) ||
                              (x?.kind === 'angles_loading' && x?.parentId === parent)
                            ),
                        ),
                      )
                      setAnglesLoading((prev) => {
                        const next = new Set(prev)
                        next.delete(parent)
                        return next
                      })
                      anglesRenderedRef.current.add(parent)
                    }
                  }
                  setMessages((m) => [
                    ...m,
                    {
                      id: newLocalId(),
                      role: 'assistant',
                      kind: 'images',
                      images: Array.isArray(imgs) ? imgs : [],
                      prompt,
                      style,
                      group,
                    } as any,
                  ])
                }
                setPhase('Visualize')
              } else if (evt.type === 'angles.start') {
                const id = evt.content?.parent_image_id || ''
                if (id) {
                  setAnglesLoading((prev) => { const next = new Set(prev); next.add(id); return next })
                  setMessages((m) => [
                    ...m.filter((x:any) => x?.kind !== 'angles_loading' || x?.parentId !== id),
                    { id: newLocalId(), role: 'assistant', kind: 'angles_loading', parentId: id } as any,
                  ])
                }
              } else if (evt.type === 'angles.ready') {
                const id = evt.content?.parent_image_id || ''
                if (id) {
                  setAnglesLoading((prev) => { const next = new Set(prev); next.delete(id); return next })
                }
                const imgs = Array.isArray(evt.content?.images) ? evt.content.images : []
                setMessages((m) => [
                  ...m.filter((x:any) =>
                    !((x?.kind === 'images' && x?.group === 'angles' && x?.parentId === id) || (x?.kind === 'angles_loading' && x?.parentId === id))),
                  { id: newLocalId(), role: 'assistant', kind: 'images', group: 'angles', parentId: id, images: imgs } as any,
                ])
                setPhase('Materialize')
              } else if (evt.type === 'i23d.ready') {
                const url = typeof evt.content?.url === 'string' ? evt.content.url : null
                if (url) {
                  setMessages((m) => [...m, { id: newLocalId(), role: 'assistant', kind: 'mesh', url } as any])
                }
                // Focus viewer
                try {
                  const allowedKinds = new Set(['repaired_stl', 'repaired_sized_stl', 'upload_stl', 'upload_obj', 'upload_glb', 'upload_gltf'])
                  const assetKind = (evt.content && (evt.content as any).asset_kind) || null
                  if (!assetKind || allowedKinds.has(assetKind)) {
                    _props.onViewerFocus?.('stl', evt.content?.url, assetKind, {
                      assetId: (evt.content as any)?.asset_id ?? null,
                      createdAt: (evt.content as any)?.created_at ?? null,
                      storageUrl: (evt.content as any)?.storage_url ?? null,
                      expiresAt: (evt.content as any)?.expires_at ?? null,
                      metrics: (evt.content as any)?.metrics ?? null,
                    })
                  }
                } catch {}
              } else if (evt.type === 'quote') {
                const q = evt.content
                setMessages((m) => {
                  return [
                    ...m,
                    {
                      role: 'assistant',
                      kind: 'quote',
                      quote: {
                        minutes: q.minutes ?? null,
                        grams: q.grams ?? null,
                        price_cents: q.price_cents ?? null,
                        total_cents: q.total_cents ?? null,
                        product_cents: q.product_cents ?? null,
                        labor_cents: q.labor_cents ?? null,
                        shipping_cents: q.shipping_cents ?? null,
                        preview_url: q.preview_url ?? null,
                      },
                    } as any,
                  ]
                })
                applyServerUpdate({ quote: q ?? null })
                setPhase('Materialize')
                jobStartAtRef.current = null
                workerWarnedRef.current = false
                clearMaterializing()
              } else if (evt.type === 'order.update') {
                const status = typeof evt.content?.status === 'string' ? evt.content.status : null
                const rawVersion = evt.content?.orderVersion
                const ver = typeof rawVersion === 'number' ? rawVersion : Number(rawVersion)
                const tAsset = typeof evt.content?.transform_asset_id === 'string' ? evt.content.transform_asset_id : null
                const exportGen = typeof evt.content?.export_generation === 'number' ? evt.content.export_generation : null
                const sliceGen = typeof evt.content?.slice_generation === 'number' ? evt.content.slice_generation : null
                applyServerUpdate({
                  status,
                  orderVersion: Number.isFinite(ver) ? ver : undefined,
                  transformAssetId: tAsset ?? null,
                  exportGeneration: exportGen ?? null,
                  sliceGeneration: sliceGen ?? null,
                })
              } else if (evt.type === 'viewer.focus') {
                const kind = evt.content?.kind as ViewerFocusKind | undefined
                const url = evt.content?.url
                const assetKind = (evt.content && (evt.content as any).asset_kind) || null
                const allowedAssetKinds = new Set(['repaired_stl', 'repaired_sized_stl', 'upload_stl', 'upload_obj', 'upload_glb', 'upload_gltf'])
                if (assetKind && !allowedAssetKinds.has(assetKind)) {
                  return
                }
                const aid = (evt.content && (evt.content as any).asset_id) || null
                const createdAt = (evt.content && (evt.content as any).created_at) || null
                const storageUrl = (evt.content && (evt.content as any).storage_url) || null
                const expiresAt = (evt.content && (evt.content as any).expires_at) || null
                const metrics = (evt.content && (evt.content as any).metrics) || null
                if (kind && focusKinds.includes(kind) && typeof url === 'string') {
                  if (aid && lastFocusAssetIdRef.current === aid) {
                    // duplicate focus for same asset; ignore
                  } else {
                    lastFocusAssetIdRef.current = aid || lastFocusAssetIdRef.current
                    _props.onViewerFocus?.(kind, url, assetKind, {
                      assetId: aid,
                      createdAt,
                      storageUrl,
                      expiresAt,
                      metrics,
                    })
                    if (typeof evt.content?.materialize_stage === 'string') {
                      applyMaterializeStage(evt.content.materialize_stage)
                    }
                    jobStartAtRef.current = null
                    workerWarnedRef.current = false
                    clearMaterializing()
                  }
                }
              } else if (evt.type === 'warning' || evt.type === 'error') {
                const t = evt.content?.text || 'Job warning'
                setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: t }])
                clearMaterializing()
              } else if (evt.type === 'text') {
                const t = evt.content?.text || ''
                if (t) setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: t }])
              }
            } else if (evt.role === 'user') {
              const evtText = evt.content?.text || ''
              if (evtText) {
                const queue = optimisticUserQueueRef.current
                if (queue.length && queue[0] === evtText) {
                  queue.shift()
                } else {
                  setMessages((m) => [...m, { role: 'user', text: evtText }])
                }
              }
            }
          } catch {}
        }
      }
      } catch (e: any) {
        const errMsg = String(e?.message || '')
        // If order not found (deleted), clear orderId and retry once
        if (errMsg.includes('not_found') && orderId && oid === orderId) {
          console.warn('[ChatPanel] Order not found, clearing stale orderId and retrying:', orderId)
          setOrderId(null)
          setStreaming(false); streamingRef.current = false
          abortRef.current = null
          // Retry send with fresh order creation
          setTimeout(() => send(text), 100)
          return
        }
        if (!errMsg.includes('not_authenticated')) {
          setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'chat error' }])
        }
        const queue = optimisticUserQueueRef.current
        if (queue.length && queue[queue.length - 1] === text) {
          queue.pop()
        }
      } finally {
        setStreaming(false); streamingRef.current = false
        abortRef.current = null
      }
  }

  // Auto-scroll chat feed to latest message (run when messages/streaming change)
  useEffect(() => {
    if (!listRef.current || !bottomRef.current) return
    requestAnimationFrame(() => {
      try { bottomRef.current!.scrollIntoView({ behavior: 'smooth', block: 'end' }) } catch {}
    })
  }, [messages, streaming])

  processAssistantEventRef.current = (evt: any, source: 'stream' | 'history' | 'channel' = 'stream') => {
    try {
      if (!evt || evt.role !== 'assistant') return
    } catch {}
  }

  const hasVisibleMessages = useMemo(() => {
    try {
      if (!Array.isArray(messages) || messages.length === 0) return false
      for (const m of messages as any[]) {
        if (!m) continue
        if (m.role === 'user') return true
        if (m.role === 'assistant') {
          const kind = (m as any).kind
          if (kind === 'images' || kind === 'mesh' || kind === 'quote') return true
        }
      }
      return false
    } catch { return false }
  }, [messages])

  return (
    <div className="flex flex-1 h-full">
      <AuthModal
        open={authModalOpen}
        onClose={() => {
          setAuthModalOpen(false)
          authPromptedRef.current = false
        }}
        onAuthenticated={handleAuthSuccess}
      />
      <div
        className={`panel relative flex flex-1 min-h-[480px] h-full flex-col overflow-hidden p-0 ${imageDragActive ? 'ring-2 ring-teal/60 shadow-[0_0_20px_rgba(46,230,214,.25)]' : ''}`}
        onDragEnter={handleConsoleDragEnter}
        onDragOver={handleConsoleDragOver}
        onDragLeave={handleConsoleDragLeave}
        onDrop={handleConsoleDrop}
      >
      {imageDragActive && (
        <>
          <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(circle_at_50%_0%,rgba(46,230,214,0.08),transparent_60%)]" />
          <div
            className="pointer-events-none absolute inset-0 z-10 opacity-[0.12]"
            style={{
              backgroundImage: 'linear-gradient(transparent 95%, rgba(255,255,255,0.12) 95%)',
              backgroundSize: '100% 3px',
            }}
          />
          <div className="pointer-events-none absolute inset-0 z-10 scan-sweep" />
        </>
      )}
      <div className="border-b border-white/10 px-4 pt-3 pb-2 text-[11px] font-semibold tracking-widest">
        <div className="text-white/80">FABRICATOR CONSOLE</div>
      </div>
      <div ref={listRef} className="relative flex-1 space-y-3 overflow-y-auto no-scrollbar p-4">
        {/* Empty-state helper: brief 3-step guidance (centered only, no header pills) */}
        {!hasVisibleMessages && !streaming && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-content-center px-6">
            <div className="mx-auto max-w-[560px] text-center">
              <div className="space-y-20 text-[13px] leading-7">
                <div className="flex flex-col items-center">
                  <span className="font-semibold text-white/80">Specify</span>
                  <span className="mt-0 text-white/60">Describe what you want to make.</span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="font-semibold text-white/80">Visualize</span>
                  <span className="mt-0 text-white/60">generate some concepts.</span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="font-semibold text-white/80">Materialize</span>
                  <span className="mt-0 text-white/60">make a 3D model.</span>
                </div>
                {showProbe && (
                  <div className="mx-auto mt-8 inline-flex items-center gap-2 rounded-md bg-white/10 px-2 py-1 text-[10px] text-white/80">
                    <span className="inline-block h-2 w-2 rounded-full bg-teal" />
                    helper-probe
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {messages.map((m, i) => {
          // Angles loading skeleton card (no timers)
          if (m.role === 'assistant' && (m as any).kind === 'angles_loading') {
            return (
              <div key={i} className="max-w-[92%]">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 shadow-[inset_0_0_0_1px_rgba(46,230,214,.08)]">
                  <div className="mb-2 flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="h-5 w-5 text-teal" aria-hidden>
                      <rect x="5" y="8" width="14" height="10" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
                    </svg>
                    <div className="text-xs text-white/70">Generating strategic angles…</div>
                  </div>
                  <div className="grid grid-cols-4 gap-2">
                    {Array.from({ length: 8 }).map((_, idx) => (
                      <div key={idx} className="aspect-square rounded-md bg-white/5" />
                    ))}
                  </div>
                </div>
              </div>
            )
          }
          return (
            <div key={i} className="max-w-[92%]">
              <div className="rounded-xl px-3.5 py-3 border border-white/10 bg-white/5">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-white/70">
                  {(m as any).role === 'assistant' ? 'Atom' : 'Command'}
                </div>
                {(m as any).role === 'assistant' && (m as any).kind === 'quote' ? (
                  <QuoteCard
                    previewUrl={(m as any).quote?.preview_url}
                    minutes={(m as any).quote?.minutes}
                    grams={(m as any).quote?.grams}
                    priceCents={(m as any).quote?.price_cents}
                    totalCents={(m as any).quote?.total_cents}
                    productCents={(m as any).quote?.product_cents}
                    laborCents={(m as any).quote?.labor_cents}
                    shippingCents={(m as any).quote?.shipping_cents}
                    canPay={false}
                  />
                ) : (
                  <div className="text-sm leading-6">{(m as any).text}</div>
                )}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-white/10 bg-black/20 p-0">
        <CommandInput
          onSend={(t) => void send(t)}
          disabled={streaming}
          loading={streaming}
          inputRef={inputRef as any}
          onUpload={() => {}}
          attachments={attachments as any}
          onAttachmentRemove={() => {}}
        />
      </div>
      </div>
    </div>
  )
}
