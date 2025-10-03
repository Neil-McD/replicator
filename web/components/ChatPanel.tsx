"use client"
import React, { useEffect, useRef, useState, useCallback } from "react"
import QuoteCard from "@/components/QuoteCard"
import { createCheckout } from "@/lib/api"
import { createOrder } from "@/lib/api"
import { authedFetch, getAccessToken, onAccessTokenChange } from "@/lib/clientAuth"
import CommandInput from "@/components/CommandInput"

type ViewerFocusKind = 'stl' | 'glb' | 'gltf' | 'obj' | 'toolpath'
type ViewerFocusMeta = { assetId?: string | null; createdAt?: string | number | null }
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
  const [phase, setPhase] = useState<'Specify'|'Visualize'|'Materialize'>('Specify')
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
  const processAssistantEventRef = useRef<(evt: any, source?: 'stream' | 'history') => void>(() => {})
  // Worker health tracking: start when materialization begins, warn if no progress
  const jobStartAtRef = useRef<number | null>(null)
  const workerWarnedRef = useRef<boolean>(false)
  const focusKinds: ViewerFocusKind[] = ['stl','glb','gltf','obj','toolpath']
  const derivePhaseFromStatus = useCallback((status?: string | null) => {
    if (!status) return 'Specify'
    const norm = status.toLowerCase()
    if (norm.includes('visual') || norm === 'await_image_pick') return 'Visualize'
    return 'Materialize'
  }, [])
  // Per-image UI state for modeling start
  const [inflightIds, setInflightIds] = useState<Set<string>>(new Set())
  const [materializingIds, setMaterializingIds] = useState<Set<string>>(new Set())
  const authPromptedRef = useRef<boolean>(false)
  const [tokenVersion, setTokenVersion] = useState<number>(0)
  
  const [remixing, setRemixing] = useState<boolean>(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const pendingUserMessageRef = useRef<string | null>(null)
  // Track dismissed quotes by hash (per order)
  const [dismissedQuotes, setDismissedQuotes] = useState<Set<string>>(new Set())
  // Inline edit target (selected concept image)
  const [editTarget, setEditTarget] = useState<{ id: string; url: string } | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const brokenImagesRef = useRef<Set<string>>(new Set())
  const [imageDragActive, setImageDragActive] = useState<boolean>(false)
  const imageDragDepthRef = useRef<number>(0)
  const { onOrderCreated } = _props

  useEffect(() => {
    setAttachments(normalizeAttachments(_props.initialAttachments))
  }, [_props.initialAttachments])

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
    setMessages((m) => [...m, { role: 'assistant', kind: 'log', text }])
  }, [setMessages])

  const ensureAuthenticated = useCallback(async () => {
    const token = await getAccessToken()
    if (!token) {
      maybePromptAuth('Sign in to start a job (orders are tied to your account).')
      return false
    }
    return true
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
                      setMessages((m) => m.filter((x:any) => !((x?.kind === 'images' && x?.group === 'angles' && x?.parentId === parent) || (x?.kind === 'angles_loading' && x?.parentId === parent))) )
                      setAnglesLoading((prev) => { const next = new Set(prev); next.delete(parent); return next })
                      anglesRenderedRef.current.add(parent)
                    }
                  }
                  setMessages((m) => [...m, { id: newLocalId(), role: 'assistant', kind: 'images', text: 'candidates', prompt, style, ...(group ? { group } : {}), ...(group === 'angles' ? { parentId: evt.content?.parent_image_id || null } : {}), ...(imgs?.length ? { images: imgs } : {}) } as any])
                }
                setPhase('Visualize')
                jobStartAtRef.current = null
                workerWarnedRef.current = false
              } else if (evt.type === 'card.attachments' || evt.type === 'attachments.update') {
                updateAttachmentsState(evt.content, { replace: true })
                setPhase('Visualize')
              } else if (evt.type === 'card.mesh') {
                pushMeshCard(evt.content)
              } else if (evt.type === 'card.job') {
                // Mark selected image(s) as active; rely on SSE for the user-visible status line
                setPhase('Materialize')
                jobStartAtRef.current = Date.now()
                workerWarnedRef.current = false
                const stageHint = typeof evt?.content?.stage === 'string' ? evt.content.stage.trim().toLowerCase() : null
                if (stageHint === 'draft' || stageHint === 'refine' || stageHint === 'high') {
                  setMaterializeStage('draft')
                }
                try {
                  const ids = Array.isArray(evt?.content?.images) ? evt.content.images.map((x: any)=>x.id).filter(Boolean) : []
                  if (ids.length) addMaterializing(ids)
                } catch {}
              } else if (evt.type === 'card.quote') {
                const q = evt.content || {}
                // Preload dismissed state for this quote if it was previously dismissed
                try {
                  const hash = computeQuoteHash(q)
                  if (hash && orderId) {
                    const key = `quote_dismissed:${orderId}:${hash}`
                    if (localStorage.getItem(key)) {
                      setDismissedQuotes((prev) => { const next = new Set(prev); next.add(hash); return next })
                    }
                  }
                } catch {}
                setMessages((m) => {
                  const hash = computeQuoteHash(q)
                  if (hash) {
                    const exists = m.some((msg: any) => msg?.role==='assistant' && msg?.kind==='quoteCard' && computeQuoteHash(msg?.quote)===hash)
                    if (exists) return m
                  }
                  return [
                    ...m,
                    { role: 'assistant', kind: 'quoteCard', quote: {
                      minutes: q.minutes ?? null,
                      grams: q.grams ?? null,
                      price_cents: q.price_cents ?? null,
                      total_cents: q.total_cents ?? null,
                      product_cents: q.product_cents ?? null,
                      labor_cents: q.labor_cents ?? null,
                      shipping_cents: q.shipping_cents ?? null,
                      preview_url: q.preview_url ?? null,
                    }, readyToPay: true } as any,
                  ]
                })
                setPhase('Materialize')
                jobStartAtRef.current = null
                workerWarnedRef.current = false
                clearMaterializing()
              } else if (evt.type === 'viewer.focus') {
                const kind = evt.content?.kind as ViewerFocusKind | undefined
                const url = evt.content?.url
                const assetKind = (evt.content && (evt.content as any).asset_kind) || null
                const allowedAssetKinds = new Set(['repaired_stl','repaired_sized_stl','upload_stl','upload_obj','upload_glb','upload_gltf'])
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
            }
          } catch {}
        }
      }
      } catch (e: any) {
        if (!String(e?.message || '').includes('not_authenticated')) {
          setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'chat error' }])
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

  processAssistantEventRef.current = (evt: any, source: 'stream' | 'history' = 'stream') => {
    try {
      if (!evt || evt.role !== 'assistant') return
      // Guard against cross-order events if any leak through
      try { if (evt?.order_id && orderId && evt.order_id !== orderId) return } catch {}
      if (source === 'stream') {
        if (evt.id && seenMsgIdsRef.current.has(evt.id)) return
        if (evt.id) seenMsgIdsRef.current.add(evt.id)
      } else {
        if (evt.id) seenMsgIdsRef.current.add(evt.id)
      }
      if (evt.type === 'card.images') {
        const groups = Array.isArray(evt.content?.groups) ? evt.content.groups : null
        const imgs = Array.isArray(evt.content?.images) ? evt.content.images : []
        const prompt = evt.content?.prompt || ''
        const style = evt.content?.style || null
        if (groups && groups.length) {
          setMessages((m) => [...m, { id: newLocalId(), role: 'assistant', kind: 'images', groups } as any])
        } else {
          const group = evt.content?.group || null
          if (group === 'angles') {
            const parent = evt.content?.parent_image_id || ''
            if (parent) {
              if (anglesRenderedRef.current.has(parent)) return
              setMessages((m) => m.filter((x:any) => !((x?.kind === 'images' && x?.group === 'angles' && x?.parentId === parent) || (x?.kind === 'angles_loading' && x?.parentId === parent))) )
              setAnglesLoading((prev) => { const next = new Set(prev); next.delete(parent); return next })
              anglesRenderedRef.current.add(parent)
            }
          }
          setMessages((m) => [
            ...m,
            {
              id: newLocalId(),
              role: 'assistant',
              kind: 'images',
              text: 'candidates',
              prompt,
              style,
              ...(group ? { group } : {}),
              ...(group === 'angles' ? { parentId: evt.content?.parent_image_id || null } : {}),
              ...(imgs?.length ? { images: imgs } : {}),
            } as any,
          ])
        }
        setPhase('Visualize')
      } else if (evt.type === 'card.attachments' || evt.type === 'attachments.update') {
        updateAttachmentsState(evt.content, { replace: true })
        setPhase('Visualize')
      } else if (evt.type === 'card.mesh') {
        pushMeshCard(evt.content)
      } else if (evt.type === 'card.job') {
        const stageHint = typeof evt?.content?.stage === 'string' ? evt.content.stage.trim().toLowerCase() : null
        if (stageHint === 'draft' || stageHint === 'refine' || stageHint === 'high') {
          setMaterializeStage('draft')
          setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: 'Materializing…' }])
        } else {
          setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: 'Materializing…' }])
        }
        // Signal Stage that a user-initiated job has begun for this order.
        try {
          if (orderId && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            const evt2 = new CustomEvent('fabricator:job-start', { detail: { orderId } })
            window.dispatchEvent(evt2)
          }
        } catch {}
        setPhase('Materialize')
        try {
          const ids = Array.isArray(evt?.content?.images) ? evt.content.images.map((x: any)=>x.id).filter(Boolean) : []
          if (ids.length) addMaterializing(ids)
        } catch {}
      } else if (evt.type === 'card.quote') {
        const q = evt.content || {}
        // Preload dismissed state from localStorage for history replay
        try {
          const hash = computeQuoteHash(q)
          if (hash && orderId) {
            const key = `quote_dismissed:${orderId}:${hash}`
            if (localStorage.getItem(key)) {
              setDismissedQuotes((prev) => { const next = new Set(prev); next.add(hash); return next })
            }
          }
        } catch {}
        setMessages((m) => {
          const hash = computeQuoteHash(q)
          if (hash) {
            const exists = m.some((msg: any) => msg?.role==='assistant' && msg?.kind==='quoteCard' && computeQuoteHash(msg?.quote)===hash)
            if (exists) return m
          }
          return [
            ...m,
            { role: 'assistant', kind: 'quoteCard', quote: {
              minutes: q.minutes ?? null,
              grams: q.grams ?? null,
              price_cents: q.price_cents ?? null,
              total_cents: q.total_cents ?? null,
              product_cents: q.product_cents ?? null,
              labor_cents: q.labor_cents ?? null,
              shipping_cents: q.shipping_cents ?? null,
              preview_url: q.preview_url ?? null,
            }, readyToPay: true } as any,
          ]
        })
        setPhase('Materialize')
        clearMaterializing()
      } else if (evt.type === 'viewer.focus') {
        const kind = evt.content?.kind as ViewerFocusKind | undefined
        const url = evt.content?.url
        const assetKind = (evt.content && (evt.content as any).asset_kind) || null
        const allowedAssetKinds = new Set(['repaired_stl','repaired_sized_stl','upload_stl','upload_obj','upload_glb','upload_gltf'])
        if (assetKind && !allowedAssetKinds.has(assetKind)) {
          return
        }
        const aid = (evt.content && (evt.content as any).asset_id) || null
        const createdAt = (evt.content && (evt.content as any).created_at) || null
        const storageUrl = (evt.content && (evt.content as any).storage_url) || null
        const expiresAt = (evt.content && (evt.content as any).expires_at) || null
        const metrics = (evt.content && (evt.content as any).metrics) || null
        if (kind && focusKinds.includes(kind) && typeof url === 'string') {
          if (!(aid && lastFocusAssetIdRef.current === aid)) {
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
            if (aid && kind !== 'stl') {
              setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: 'Toolpath preview ready.' }])
            }
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
    } catch (error) {
      console.warn('[ChatPanel] failed to process assistant event', error)
    }
  }

  // Subscribe to background updates with BroadcastChannel leadership per order
  useEffect(() => {
    if (!orderId) {
      if (sseRef.current) { try { sseRef.current.abort?.() } catch {} ; sseRef.current = null }
      try { if (electionTimerRef.current) clearTimeout(electionTimerRef.current) } catch {}
      try { if (hbIntervalRef.current) clearInterval(hbIntervalRef.current) } catch {}
      try { if (hbMissTimerRef.current) clearTimeout(hbMissTimerRef.current) } catch {}
      try { bcRef.current?.close?.() } catch {}
      bcRef.current = null
      roleRef.current = null
      leaderIdRef.current = null
      return
    }

    const hasBC = typeof window !== 'undefined' && 'BroadcastChannel' in window
    const channelName = `replicator:${orderId}`
    const td = new TextDecoder()

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryCount = 0
    let abortController: AbortController | null = null

    const cleanupStream = () => {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      if (abortController) { try { abortController.abort() } catch {} ; if (sseRef.current === abortController) sseRef.current = null; abortController = null }
    }

    const broadcast = (msg: any) => {
      try { bcRef.current?.postMessage?.(msg) } catch {}
    }

    const becomeLeader = () => {
      if (roleRef.current === 'leader') return
      roleRef.current = 'leader'
      leaderIdRef.current = tabIdRef.current
      broadcast({ kind: 'leader-announce', order_id: orderId, tabId: tabIdRef.current, ts: Date.now() })
      // Heartbeat every 2s
      if (hbIntervalRef.current) clearInterval(hbIntervalRef.current)
      hbIntervalRef.current = setInterval(() => {
        broadcast({ kind: 'leader-heartbeat', order_id: orderId, tabId: tabIdRef.current, ts: Date.now() })
      }, 2000)
      // Start SSE
      openStream().catch(() => {})
    }

    const becomeFollower = (leaderId: string) => {
      if (roleRef.current === 'follower' && leaderIdRef.current === leaderId) return
      roleRef.current = 'follower'
      leaderIdRef.current = leaderId
      cleanupStream()
      if (hbIntervalRef.current) { clearInterval(hbIntervalRef.current); hbIntervalRef.current = null }
    }

    const handleBC = (event: MessageEvent) => {
      const data: any = event.data
      if (!data || data.order_id !== orderId) return
      if (data.kind === 'leader-announce') {
        // Tie-break: smallest tabId wins
        const incoming = String(data.tabId || '')
        const mine = String(tabIdRef.current)
        if (!incoming) return
        if (roleRef.current !== 'leader') {
          becomeFollower(incoming)
        } else {
          if (incoming < mine) {
            // Demote self
            becomeFollower(incoming)
          }
        }
      } else if (data.kind === 'leader-heartbeat') {
        // Reset miss timer; followers watch for leader silence
        if (roleRef.current !== 'leader') {
          const incoming = String(data.tabId || '')
          leaderIdRef.current = incoming || leaderIdRef.current
          if (hbMissTimerRef.current) clearTimeout(hbMissTimerRef.current)
          hbMissTimerRef.current = setTimeout(() => {
            // If no heartbeat for ~6s, try to lead
            becomeLeader()
          }, 6000)
        }
      } else if (data.kind === 'bye') {
        if (roleRef.current !== 'leader' && leaderIdRef.current && data.tabId === leaderIdRef.current) {
          // Leader left; try to assume leadership
          becomeLeader()
        }
      } else if (data.kind === 'sse-event') {
        // Follower consumes rebroadcasted events
        if (roleRef.current === 'follower') {
          const evt = data.payload
          try {
            if (evt?.order_id && orderId && evt.order_id !== orderId) return
            if (evt.role === 'assistant') {
              processAssistantEventRef.current(evt, 'channel')
            } else if (evt.role === 'user') {
              const text = evt.content?.text || ''
              if (text) setMessages((m) => [...m, { role: 'user', text }])
            }
          } catch {}
        }
      }
    }

  const openStream = async () => {
      if (cancelled) return
      if (roleRef.current !== 'leader') return
      try {
        const token = await getAccessToken()
        if (!token) { maybePromptAuth('Sign in to monitor fabrication progress.'); return }
        const url = `/api/chat/stream?orderId=${encodeURIComponent(orderId)}`
        abortController = new AbortController()
        sseRef.current = abortController
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: abortController.signal })
        if (!res.ok || !res.body) throw new Error(`sse_http_${res.status}`)
        const reader = res.body.getReader()
        let buffer = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value) continue
          buffer += td.decode(value, { stream: true })
          let idx
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const lines = chunk.split('\n').map((l) => l.trim())
            const dataLines = lines.filter((l) => l.startsWith('data:'))
            if (!dataLines.length) continue
            const payload = dataLines.map((l) => l.slice(5).trimStart()).join('\n')
            try {
              const evt = JSON.parse(payload)
              if (!evt) continue
              if (evt?.order_id && orderId && evt.order_id !== orderId) continue
              if (evt.type === 'history') {
                // Use server history only when no warm snapshot was applied and UI hasn't painted yet.
                if (!historyPrimedRef.current && messages.length === 0) {
                  try {
                    const items = Array.isArray(evt?.content?.items) ? evt.content.items : []
                    for (const it of items) {
                      const id = it?.id
                      if (id && seenMsgIdsRef.current.has(id)) continue
                      if (id) seenMsgIdsRef.current.add(id)
                      const role = it?.role
                      const type = it?.type
                      const content = it?.content_json || {}
                      const evtObj = { role, type, content }
                      if (role === 'assistant') {
                        processAssistantEventRef.current(evtObj, 'history')
                      } else if (role === 'user') {
                        const text = content?.text || ''
                        if (text) setMessages((m) => [...m, { role: 'user', text }])
                      }
                    }
                    historyPrimedRef.current = true
                  } catch {}
                }
                continue
              }
              // Leader processes locally
              if (evt.role === 'assistant') {
                processAssistantEventRef.current(evt, 'stream')
              } else if (evt.role === 'user') {
                const text = evt.content?.text || ''
                if (text) setMessages((m) => [...m, { role: 'user', text }])
              }
              // And rebroadcast to followers
              broadcast({ kind: 'sse-event', order_id: orderId, payload: evt })
            } catch {}
          }
        }
        // Successful connection, reset retry counter
        retryCount = 0
      } catch (err) {
        cleanupStream()
        if (!cancelled && roleRef.current === 'leader') {
          const base = 2000 * Math.pow(2, Math.min(retryCount, 4))
          const jitter = 500 + Math.random() * 1500
          const delay = Math.min(30000, base + jitter)
          retryTimer = setTimeout(() => { retryTimer = null; retryCount += 1; openStream().catch(() => {}) }, delay)
        }
      }
    }

    // Setup BroadcastChannel if available
    let removeVis: (() => void) | null = null
    if (hasBC) {
      try {
        bcRef.current?.close?.()
      } catch {}
      bcRef.current = new BroadcastChannel(channelName)
      bcRef.current.onmessage = handleBC
      // Start election: if no leader announces quickly, lead
      electionTimerRef.current && clearTimeout(electionTimerRef.current)
      broadcast({ kind: 'hello', order_id: orderId, tabId: tabIdRef.current, ts: Date.now() })
      electionTimerRef.current = setTimeout(() => {
        if (roleRef.current !== 'leader') becomeLeader()
      }, 350)

      // Prefer visible tab for leadership
      const handleVis = () => {
        try {
          if (document.visibilityState === 'visible' && roleRef.current !== 'leader') {
            // Nudge election with small jitter
            const delay = 150 + Math.floor(Math.random() * 250)
            setTimeout(() => { if (roleRef.current !== 'leader') becomeLeader() }, delay)
          }
        } catch {}
      }
      document.addEventListener('visibilitychange', handleVis)
      removeVis = () => document.removeEventListener('visibilitychange', handleVis)
    } else {
      // No BC support; fall back to local SSE
      roleRef.current = 'leader'
      openStream().catch(() => {})
    }

    return () => {
      cancelled = true
      try { if (electionTimerRef.current) clearTimeout(electionTimerRef.current) } catch {}
      try { if (hbIntervalRef.current) clearInterval(hbIntervalRef.current) } catch {}
      try { if (hbMissTimerRef.current) clearTimeout(hbMissTimerRef.current) } catch {}
      if (sseRef.current) { try { sseRef.current.abort?.() } catch {} ; sseRef.current = null }
      if (hasBC) {
        try { removeVis?.() } catch {}
        broadcast({ kind: 'bye', order_id: orderId, tabId: tabIdRef.current, ts: Date.now() })
        try { bcRef.current?.close?.() } catch {}
        bcRef.current = null
      }
      roleRef.current = null
      leaderIdRef.current = null
    }
  }, [orderId, tokenVersion, maybePromptAuth])

  // Perf: mark start/end of initial chat paint
  useEffect(() => {
    try { if (typeof performance !== 'undefined') performance.mark('chat_paint_start') } catch {}
  }, [])
  useEffect(() => {
    if (chatPaintMeasuredRef.current) return
    if (messages.length > 0) {
      try {
        if (typeof performance !== 'undefined') {
          performance.mark('chat_paint_end')
          try { performance.measure('time_to_chat_paint', 'chat_paint_start', 'chat_paint_end') } catch {}
          const entries = performance.getEntriesByName('time_to_chat_paint')
          const last = entries[entries.length - 1]
          if (last && (process.env.NODE_ENV !== 'production')) {
            console.debug('[Perf] time_to_chat_paint', Math.round(last.duration), 'ms')
          }
        }
      } catch {}
      chatPaintMeasuredRef.current = true
    }
  }, [messages.length])

  useEffect(() => {
    if (!orderId) return
    const history = _props.initialMessages
    const hasHistory = Array.isArray(history) && history.length > 0
    const historyVersion = hasHistory
      ? history
          .map((msg) => {
            if (!msg) return 'ø'
            const base = `${msg.id || '∅'}:${msg.type || msg.role || '∅'}`
            if (msg.type === 'card.images' && Array.isArray((msg as any)?.content?.images)) {
              const urls = ((msg as any).content.images as any[]).map((img) => (img?.url as string) || '').join('|')
              return `${base}:${urls}`
            }
            if (msg.type === 'text') {
              return `${base}:${((msg as any)?.content?.text as string) || ''}`
            }
            return `${base}:${JSON.stringify((msg as any)?.content ?? {})}`
          })
          .join('~')
      : 'empty'
    const appliedKey = `${orderId}:${historyVersion}`
    if (historyAppliedOrderRef.current === appliedKey) return
    historyAppliedOrderRef.current = appliedKey
    anglesRenderedRef.current = new Set()
    seenMsgIdsRef.current = new Set()
    lastFocusAssetIdRef.current = null
    if (hasHistory) {
      historyPrimedRef.current = true
      setMessages([])
      pendingUserMessageRef.current = null
    } else {
      const pending = pendingUserMessageRef.current
      if (typeof pending === 'string' && pending.length) {
        setMessages([{ role: 'user', text: pending }])
        pendingUserMessageRef.current = null
      } else {
        setMessages([])
      }
    }
    setAnglesLoading(new Set())
    setAnglesBatchInflight(new Set())
    setInflightIds(new Set())
    setMaterializingIds(new Set())
    setRemixingIds(new Set())
    brokenImagesRef.current = new Set()
    jobStartAtRef.current = null
    workerWarnedRef.current = false
    if (hasHistory) {
      for (const msg of history as HistoryMessage[]) {
        if (!msg || !msg.role) continue
        if (msg.role === 'assistant') {
          processAssistantEventRef.current({ id: msg.id, role: 'assistant', type: msg.type, content: msg.content }, 'history')
        } else if (msg.role === 'user') {
          const text = msg?.content?.text || ''
          if (text) setMessages((m) => [...m, { role: 'user', text }])
        } else if (msg.role === 'tool') {
          const text = typeof msg.content === 'string' ? msg.content : msg?.content?.text || ''
          if (text) setMessages((m) => [...m, { role: 'assistant', kind: 'log', text }])
        }
      }
    }
    if (_props.initialStatus) {
      setPhase(derivePhaseFromStatus(_props.initialStatus))
    }
  }, [orderId, _props.initialMessages, _props.initialStatus, derivePhaseFromStatus])

  // Optional: worker health watchdog. Disabled by default unless NEXT_PUBLIC_WORKER_HINT_MS > 0.
  useEffect(() => {
    const HINT_MS_RAW = (typeof process !== 'undefined' && (process.env.NEXT_PUBLIC_WORKER_HINT_MS as string)) || '0'
    const HINT_MS = Math.max(0, Number(HINT_MS_RAW) || 0)
    if (!HINT_MS) return
    const iv = setInterval(() => {
      const started = jobStartAtRef.current
      if (!started || workerWarnedRef.current) return
      const elapsed = Date.now() - started
      if (elapsed > HINT_MS) {
        workerWarnedRef.current = true
        setMessages((m) => [
          ...m,
          { role: 'assistant', kind: 'log', text: 'Preparing the mesh…' },
        ])
      }
    }, 2000)
    return () => clearInterval(iv)
  }, [])

  return (
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
        <div className="mt-2 flex items-center gap-1 overflow-x-auto whitespace-nowrap no-scrollbar">
          <span className={`phase-chip ${phase==='Specify' ? 'phase-chip-active' : ''}`}><span className="phase-dot" /> SPECIFY</span>
          <span className="phase-arrow">·</span>
          <span className={`phase-chip ${phase==='Visualize' ? 'phase-chip-active' : ''}`}><span className="phase-dot" /> VISUALIZE</span>
          <span className="phase-arrow">·</span>
          <span className={`phase-chip ${phase==='Materialize' ? 'phase-chip-active' : ''}`}><span className="phase-dot" /> MATERIALIZE</span>
        </div>
      </div>
      <div ref={listRef} className="relative flex-1 space-y-3 overflow-y-auto no-scrollbar p-4">
        {/* Empty-state helper: brief 3-step guidance */}
        {messages.length === 0 && !streaming && !_props.loadingSnapshot && (
          <div className="pointer-events-none absolute inset-0 grid place-content-center px-6">
            <div className="mx-auto max-w-[560px] text-center">
              <div className="space-y-20 text-[13px] leading-7">
                <div className="flex flex-col items-center">
                  <span className="font-semibold text-tealGlow/50">Specify</span>
                  <span className="mt-0 text-white/45">Describe what you want to make.</span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="font-semibold text-tealGlow/50">Visualize</span>
                  <span className="mt-0 text-white/45">generate some concepts.</span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="font-semibold text-tealGlow/50">Materialize</span>
                  <span className="mt-0 text-white/45">make a 3D model.</span>
                </div>
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
                      <circle cx="9" cy="13" r="1" fill="currentColor" />
                      <circle cx="15" cy="13" r="1" fill="currentColor" />
                      <line x1="12" y1="3" x2="12" y2="7" stroke="currentColor" strokeWidth="2" />
                      <circle cx="12" cy="2" r="1" fill="currentColor" />
                      <line x1="9" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                    <div className="text-xs font-semibold text-white/70">Atom</div>
                    <div className="ml-auto text-[11px] font-semibold tracking-wider text-white/60 uppercase">Angles</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {Array.from({ length: 3 }).map((_, idx) => (
                      <div key={idx} className="aspect-square w-full rounded-lg bg-white/10 animate-pulse" />
                    ))}
                  </div>
                </div>
              </div>
            )
          }
          if (m.role === 'assistant' && (m as any).kind === 'quoteCard') {
            const q = (m as any).quote || {}
            const minutes = typeof q.minutes === 'number' ? q.minutes : undefined
            const grams = typeof q.grams === 'number' ? q.grams : undefined
            const totalCents = typeof q.total_cents === 'number' ? q.total_cents : (typeof q.price_cents === 'number' ? q.price_cents : undefined)
            const productCents = typeof q.product_cents === 'number' ? q.product_cents : undefined
            const laborCents = typeof q.labor_cents === 'number' ? q.labor_cents : undefined
            const shippingCents = typeof q.shipping_cents === 'number' ? q.shipping_cents : undefined
            const previewUrl = typeof q.preview_url === 'string' ? q.preview_url : undefined
            const readyToPay = typeof _props.initialStatus === 'string' && _props.initialStatus.toLowerCase() === 'ready_to_pay'
            const readyToPayFromMsg = (m as any).readyToPay === true
            const canPay = Boolean(orderId && typeof totalCents === 'number' && (readyToPay || readyToPayFromMsg))
            const hash = computeQuoteHash(q)
            const isDismissed = !!(hash && dismissedQuotes.has(hash))
            if (isDismissed) return null
            return (
              <div key={i} className="max-w-[92%]">
                <QuoteCard
                  previewUrl={previewUrl}
                  minutes={minutes}
                  grams={grams}
                  priceCents={typeof q.price_cents === 'number' ? q.price_cents : undefined}
                  totalCents={totalCents}
                  productCents={productCents}
                  laborCents={laborCents}
                  shippingCents={shippingCents}
                  canPay={canPay}
                  onPay={async () => {
                    if (!orderId) return
                    try {
                      const { url } = await createCheckout(orderId)
                      if (url) window.location.href = url
                    } catch (err: any) {
                      setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: err?.message || 'checkout failed' }])
                    }
                  }}
                  onDismiss={() => {
                    dismissQuoteHash(hash)
                    setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: 'Quote dismissed. You can continue editing or reslice anytime.' }])
                  }}
                  onContinueEditing={async () => {
                    if (!orderId) return
                    try {
                      const res = await authedFetchSafe(`/api/orders/${orderId}/continue-editing`, { method: 'POST' })
                      if (res.ok) {
                        dismissQuoteHash(hash)
                        setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: 'Returned to editing. Adjust size or orientation, then reslice for a new quote.' }])
                      } else {
                        const payload = await res.json().catch(()=>null)
                        const msg = payload?.message || 'Failed to continue editing'
                        setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: msg }])
                      }
                    } catch (e: any) {
                      if (!String(e?.message || '').includes('not_authenticated')) {
                        setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: e?.message || 'continue editing failed' }])
                      }
                    }
                  }}
                />
              </div>
            )
          }
          // Grouped concept card: 2 concepts × 3 angles each
          if (m.role === 'assistant' && (m as any).groups) {
            const groups = (m as any).groups as { concept: number; images: { id: string; url: string; angle: string }[] }[]
            return (
              <div key={i} className="max-w-[92%]">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 shadow-[inset_0_0_0_1px_rgba(46,230,214,.08)]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 24 24" className="h-5 w-5 text-teal" aria-hidden>
                        <rect x="5" y="8" width="14" height="10" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
                        <circle cx="9" cy="13" r="1" fill="currentColor" />
                        <circle cx="15" cy="13" r="1" fill="currentColor" />
                        <line x1="12" y1="3" x2="12" y2="7" stroke="currentColor" strokeWidth="2" />
                        <circle cx="12" cy="2" r="1" fill="currentColor" />
                        <line x1="9" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <div className="text-xs font-semibold text-white/70">Atom</div>
                    </div>
                    <div className="text-[11px] font-semibold tracking-wider text-white/60 uppercase">Candidates</div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {groups.map((g) => {
                      const ids = g.images.map((im) => im.id)
                      const inflight = ids.some((id) => inflightIds.has(id))
                      const active = ids.some((id) => materializingIds.has(id))
                      return (
                        <div key={`concept-${g.concept}`} className="group relative overflow-hidden rounded-lg border border-white/10 p-1">
                          <div className="grid grid-cols-3 gap-1">
                            {g.images.slice(0,3).map((im) => (
                              <img
                                key={im.id}
                                src={im.url}
                                alt={`concept ${g.concept} ${im.angle}`}
                                className="aspect-square w-full object-cover"
                                onError={() => refreshImageUrl(im.id, (im as any)?.storage_url || null)}
                              />
                            ))}
                          </div>
                          {active && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50">
                              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-teal/70 border-t-transparent" />
                              <div className="mt-2 text-xs text-white/90">Generating 3D model…</div>
                            </div>
                          )}
                          <div className="absolute inset-0 flex items-end justify-end p-2">
                            <button
                              className={`rounded-md border border-teal-300/30 bg-teal-400/20 px-2 py-1 text-xs transition-opacity hover:bg-teal-400/30 active:scale-[.98] focus:outline-none focus:ring-2 focus:ring-teal-400/40 ${active ? 'opacity-75' : 'opacity-0 group-hover:opacity-100'}`}
                              disabled={inflight || active}
                              onClick={async () => {
                                if (!orderId) return
                                if (inflight || active) return
                                // Mark all ids inflight to control UI
                                ids.forEach((id) => addInflight(id))
                                try {
                                const res = await authedFetchSafe('/api/materialize', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ orderId, imageIds: ids }),
                                  })
                                  if (!res.ok) {
                                    let msg = 'materialize failed'
                                    try { const d = await res.json(); if (d?.error) msg = d.error } catch {}
                                    setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: msg }])
                                    ids.forEach((id) => clearInflight(id))
                                    return
                                  }
                                  ids.forEach((id) => clearInflight(id))
                                  addMaterializing(ids)
                                  setPhase('Materialize')
                                  jobStartAtRef.current = Date.now()
                                  workerWarnedRef.current = false
                                } catch (e: any) {
                                  if (!String(e?.message || '').includes('not_authenticated')) {
                                    setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'materialize failed' }])
                                  }
                                  ids.forEach((id) => clearInflight(id))
                                }
                              }}
                            >
                              {active ? 'Selected' : inflight ? 'Starting…' : 'Materialize'}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          }

          if (m.role === 'assistant' && (m as any).images) {
            const imgs = (m as any).images as { id: string; url: string }[]
            const mPrompt = (m as any).prompt as string | undefined
            const mStyle = (m as any).style as string | undefined
            const mGroup = (m as any).group as string | undefined
            return (
              <div key={i} className="max-w-[92%]">
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 shadow-[inset_0_0_0_1px_rgba(46,230,214,.08)]">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <svg viewBox="0 0 24 24" className="h-5 w-5 text-teal" aria-hidden>
                        <rect x="5" y="8" width="14" height="10" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
                        <circle cx="9" cy="13" r="1" fill="currentColor" />
                        <circle cx="15" cy="13" r="1" fill="currentColor" />
                        <line x1="12" y1="3" x2="12" y2="7" stroke="currentColor" strokeWidth="2" />
                        <circle cx="12" cy="2" r="1" fill="currentColor" />
                        <line x1="9" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <div className="text-xs font-semibold text-white/70">Atom</div>
                    </div>
                    <div className="text-[11px] font-semibold tracking-wider text-white/60 uppercase">{mGroup === 'angles' ? 'Angles' : 'Candidates'}</div>
                    
                    {!!orderId && (
                      <button
                        className={`flex items-center gap-1 text-[12px] focus:outline-none ${remixingIds.has((m as any).id || '') ? 'text-white/60 cursor-wait' : 'text-white/70 hover:text-white'}`}
                        aria-label="Remix"
                        title="Remix"
                        disabled={remixingIds.has((m as any).id || '')}
                        onClick={async () => {
                          const localId = (m as any).id || newLocalId()
                          try {
                            addRemixing(localId)
                            if ((m as any).group === 'angles' && (m as any).parentId) {
                              // Rerun angles for the same parent image
                              const parent = (m as any).parentId as string
                              // Allow a fresh angles card to appear
                              anglesRenderedRef.current.delete(parent)
                              setAnglesLoading((prev) => { const next = new Set(prev); next.add(parent); return next })
                              const res = await authedFetchSafe('/api/angles', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ orderId, imageId: parent, angles: ['top','bottom','opposite'] }),
                              })
                              // Replace any old angles card and show fresh results if API responds immediately
                              setMessages((mm) => mm.filter((x:any) => !((x?.kind === 'images' && x?.group === 'angles' && x?.parentId === parent) || (x?.kind === 'angles_loading' && x?.parentId === parent))) )
                              // If API returns images, show immediately and mark rendered to avoid duplicate SSE replacement
                              try {
                                const d = await res.json()
                                const imgs = Array.isArray(d?.images) ? d.images : []
                                if (imgs.length) {
                                  setMessages((mm) => [...mm, { id: newLocalId(), role: 'assistant', kind: 'images', group: 'angles', parentId: parent, images: imgs } as any])
                                  anglesRenderedRef.current.add(parent)
                                  setAnglesLoading((prev) => { const next = new Set(prev); next.delete(parent); return next })
                                }
                              } catch {}
                            } else {
                              // Rerun initial concepts
                              await authedFetchSafe('/api/visualize', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ orderId, prompt: mPrompt || 'remix', n: 2, ...(mStyle ? { style: mStyle } : {}) }),
                              })
                              setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: 'Remixing…' }])
                              setPhase('Visualize')
                            }
                          } catch (e: any) {
                            if (!String(e?.message || '').includes('not_authenticated')) {
                              setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: e?.message || 'remix failed' }])
                            }
                          } finally {
                            clearRemixing(localId)
                          }
                        }}
                      >
                        <svg viewBox="0 0 24 24" className={`h-4 w-4 ${remixingIds.has((m as any).id || '') ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M20 12a8 8 0 1 1-8-8" />
                          <path d="M12 4v4H8" />
                        </svg>
                        <span>Rerun</span>
                      </button>
                    )}
                  </div>
                  <div className={`mt-2 grid ${mGroup === 'angles' ? 'grid-cols-3' : 'grid-cols-2'} gap-2`}>
                    {imgs.map((im) => {
                      const inflight = inflightIds.has(im.id)
                      const active = materializingIds.has(im.id)
                      return (
                        <div
                          key={im.id}
                          className="group relative overflow-hidden rounded-lg border border-white/10 cursor-zoom-in"
                          onClick={() => setPreviewUrl(im.url)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setPreviewUrl(im.url) }}
                        >
                          <img
                            src={im.url}
                            alt="candidate"
                            className="aspect-square w-full object-cover"
                            onError={() => refreshImageUrl(im.id, (im as any)?.storage_url || null)}
                          />
                          {mGroup === 'angles' && (
                            <div className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white/85">
                              {typeof (im as any)?.angle === 'string' ? ((im as any).angle as string).slice(0,1).toUpperCase() + ((im as any).angle as string).slice(1) : 'Angle'}
                            </div>
                          )}
                          {/* Hover shade when idle (not for angles) */}
                          {mGroup !== 'angles' && !active && (
                            <div className="pointer-events-none absolute inset-0 bg-black/40 opacity-0 transition-opacity group-hover:opacity-100" />
                          )}
                          {/* Top-left: More Angles (only on regular candidates) */}
                          {mGroup !== 'angles' && (
                          <div className="absolute left-2 top-2 pointer-events-auto">
                            <button
                              className={`rounded-md border border-white/15 bg-black/50 px-2 py-1 text-[11px] text-white/85 transition-opacity ${active ? 'opacity-50' : 'opacity-0 group-hover:opacity-100'}`}
                              disabled={inflight || active || anglesLoading.has(im.id)}
                              onClick={async (ev) => {
                                ev.stopPropagation()
                                if (!orderId) return
                                if (inflight || active || anglesLoading.has(im.id)) return
                                addInflight(im.id)
                                setAnglesLoading((prev) => { const next = new Set(prev); next.add(im.id); return next })
                                // Show a simple skeleton card (no timers)
                                setMessages((m) => [...m, { role: 'assistant', kind: 'angles_loading', parentId: im.id } as any])
                                try {
                                  const res = await authedFetchSafe('/api/angles', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ orderId, imageId: im.id, angles: ['top','bottom','opposite'] }),
                                  })
                                  if (!res.ok) {
                                    let msg = 'more angles failed'
                                    try { const d = await res.json(); if (d?.error) msg = d.error } catch {}
                                    setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: msg }])
                                    clearInflight(im.id)
                                    setAnglesLoading((prev) => { const next = new Set(prev); next.delete(im.id); return next })
                                    return
                                  }
                                  // Also update immediately if the API returns images (avoid waiting solely on SSE)
                                  try {
                                    const d = await res.json()
                                    const imgs = Array.isArray(d?.images) ? d.images : []
                                    if (imgs.length) {
                                      setMessages((mm) => [
                                        ...mm.filter((x:any) => !(x?.kind === 'angles_loading' && x?.parentId === im.id)),
                                        { id: newLocalId(), role: 'assistant', kind: 'images', group: 'angles', parentId: im.id, images: imgs } as any,
                                      ])
                                      anglesRenderedRef.current.add(im.id)
                                      setAnglesLoading((prev) => { const next = new Set(prev); next.delete(im.id); return next })
                                    }
                                  } catch {}
                                } catch (e: any) {
                                  if (!String(e?.message || '').includes('not_authenticated')) {
                                    setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'more angles failed' }])
                                  }
                                  clearInflight(im.id)
                                  setAnglesLoading((prev) => { const next = new Set(prev); next.delete(im.id); return next })
                                } finally {
                                  clearInflight(im.id)
                                }
                              }}
                            >
                              {anglesLoading.has(im.id) ? (
                                <span className="inline-flex items-center gap-1">
                                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-teal/70 border-t-transparent" />
                                  Generating…
                                </span>
                              ) : (
                                'More Angles'
                              )}
                            </button>
                          </div>
                          )}
                          {/* Expand icon intentionally removed per request; click anywhere on tile still opens preview */}
                          {/* Active overlay when materializing */}
                          {active && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50">
                              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-teal/70 border-t-transparent" />
                              <div className="mt-2 text-xs text-white/90">Generating 3D model…</div>
                            </div>
                          )}
                          {mGroup !== 'angles' && (
                          <div className="absolute inset-0 flex items-end justify-between p-2 pointer-events-none">
                            {/* Edit button (bottom-left) */}
                            <button
                              className={`pointer-events-auto rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs text-white/80 transition-opacity ${active ? 'opacity-50' : 'opacity-0 group-hover:opacity-100'}`}
                              disabled={active}
                              onClick={async (ev) => {
                                ev.stopPropagation()
                                if (!orderId) return
                                // Pull this concept down near the input and focus the text box
                                setEditTarget({ id: im.id, url: im.url })
                                setTimeout(() => {
                                  try { inputRef.current?.focus() } catch {}
                                  try { bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) } catch {}
                                }, 10)
                              }}
                            >Edit</button>
                            <button
                              className={`pointer-events-auto rounded-md border border-teal-300/30 bg-teal-400/20 px-2 py-1 text-xs transition-opacity hover:bg-teal-400/30 active:scale-[.98] focus:outline-none focus:ring-2 focus:ring-teal-400/40 ${active ? 'opacity-75' : 'opacity-0 group-hover:opacity-100'}`}
                              disabled={inflight || active}
                              onClick={async (ev) => {
                                ev.stopPropagation()
                                if (!orderId) return
                                if (inflight || active) return
                                addInflight(im.id)
                                try {
                                  const res = await authedFetchSafe('/api/materialize', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ orderId, imageIds: [im.id] }),
                                  })
                                  if (!res.ok) {
                                    let msg = 'materialize failed'
                                    try { const d = await res.json(); if (d?.error) msg = d.error } catch {}
                                    setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: msg }])
                                    clearInflight(im.id)
                                    return
                                  }
                                  // Server acknowledged — show spinner and log
                                  clearInflight(im.id)
                                  addMaterializing([im.id])
                                  setPhase('Materialize')
                                  jobStartAtRef.current = Date.now()
                                  workerWarnedRef.current = false
                                } catch (e: any) {
                                  if (!String(e?.message || '').includes('not_authenticated')) {
                                    setMessages((m) => [...m, { role: 'assistant', kind: 'log', text: e?.message || 'materialize failed' }])
                                  }
                                  clearInflight(im.id)
                                }
                              }}
                            >
                              {active ? 'Selected' : inflight ? 'Starting…' : 'Materialize'}
                            </button>
                          </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {mGroup === 'angles' && imgs.length > 0 && !!orderId && (
                    <div className="mt-2 flex justify-end">
                      <button
                        className={`rounded-md border border-teal-300/30 bg-teal-400/20 px-2 py-1 text-xs text-white/90 transition-colors active:scale-[.98] hover:bg-teal-400/30 focus:outline-none focus:ring-2 focus:ring-teal-400/40 disabled:cursor-not-allowed disabled:opacity-60`}
                        onClick={async () => {
                          try {
                            const ids = imgs.map((im) => im.id)
                            if (!ids.length) return
                            // Mark this angles card as inflight immediately for feedback
                            const parentId = (m as any).parentId as string | undefined
                            if (parentId) {
                              setAnglesBatchInflight((prev) => { const next = new Set(prev); next.add(parentId); return next })
                            }
                            await authedFetchSafe('/api/materialize', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ orderId, imageIds: ids }),
                            })
                            addMaterializing(ids)
                            setPhase('Materialize')
                            jobStartAtRef.current = Date.now()
                            workerWarnedRef.current = false
                            if (parentId) {
                              setAnglesBatchInflight((prev) => { const next = new Set(prev); next.delete(parentId); return next })
                            }
                          } catch (e: any) {
                            if (!String(e?.message || '').includes('not_authenticated')) {
                              setMessages((mm) => [...mm, { role: 'assistant', kind: 'log', text: e?.message || 'materialize failed' }])
                            }
                            const parentId = (m as any).parentId as string | undefined
                            if (parentId) {
                              setAnglesBatchInflight((prev) => { const next = new Set(prev); next.delete(parentId); return next })
                            }
                          }
                        }}
                        disabled={(() => { const pid = (m as any).parentId as string | undefined; return !!(pid && anglesBatchInflight.has(pid)) })()}
                      >
                        {(() => {
                          const pid = (m as any).parentId as string | undefined
                          return pid && anglesBatchInflight.has(pid) ? 'Starting…' : 'Materialize'
                        })()}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          }
          return (
            <div key={i} className={m.role === 'user' ? 'ml-auto max-w-[92%]' : 'max-w-[92%]'}>
              <div className={m.role === 'user' ? 'rounded-xl px-3.5 py-3 border border-white/10 bg-black/30 text-textPrimary glow-teal' : 'rounded-xl px-3.5 py-3 border border-white/10 bg-white/5'}>
                <div className="mb-1 flex items-center gap-2">
                  {m.role === 'assistant' ? (
                    <>
                      <svg viewBox="0 0 24 24" className="h-5 w-5 text-teal" aria-hidden>
                        <rect x="5" y="8" width="14" height="10" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
                        <circle cx="9" cy="13" r="1" fill="currentColor" />
                        <circle cx="15" cy="13" r="1" fill="currentColor" />
                        <line x1="12" y1="3" x2="12" y2="7" stroke="currentColor" strokeWidth="2" />
                        <circle cx="12" cy="2" r="1" fill="currentColor" />
                        <line x1="9" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                      <div className="text-[11px] uppercase tracking-wider text-white/70">Atom</div>
                    </>
                  ) : (
                    <div className="text-[11px] uppercase tracking-wider text-white/60">Command</div>
                  )}
                </div>
                <div className="text-sm leading-6">{m.text}</div>
              </div>
            </div>
          )
        })}
        {streaming && (
          <div className="max-w-[92%]">
            <div className="rounded-xl px-3.5 py-3 border border-white/10 bg-white/5">
              <div className="mb-1 flex items-center gap-2">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-teal" aria-hidden>
                  <rect x="5" y="8" width="14" height="10" rx="4" stroke="currentColor" strokeWidth="2" fill="none" />
                  <circle cx="9" cy="13" r="1" fill="currentColor" />
                  <circle cx="15" cy="13" r="1" fill="currentColor" />
                  <line x1="12" y1="3" x2="12" y2="7" stroke="currentColor" strokeWidth="2" />
                  <circle cx="12" cy="2" r="1" fill="currentColor" />
                  <line x1="9" y1="16" x2="15" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <div className="text-[11px] uppercase tracking-wider text-white/70">Atom</div>
              </div>
              <div className="flex items-center gap-2 text-sm text-textMuted">
                <span className="inline-block h-[10px] w-[10px] animate-spin rounded-full border-2 border-teal/60 border-t-transparent" />
                <span>Thinking…</span>
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {/* Inline edit target preview */}
      {editTarget && (
        <div className="border-t border-teal/30 bg-black/30 px-3 py-2">
          <div className="flex items-center gap-3 rounded-lg border border-teal/40 bg-teal/10 p-2">
            <img src={editTarget.url} alt="editing concept" className="h-14 w-14 rounded-md object-cover ring-2 ring-teal/60" />
            <div className="flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-teal/80">Editing Concept</div>
              <div className="text-[12px] text-white/70">Describe the change and press Enter.</div>
            </div>
            <button
              className="rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs text-white/80 hover:bg-white/10"
              onClick={() => setEditTarget(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {materializeStage === 'draft' && (
        <div className="border-t border-teal/30 bg-black/25 px-3 py-2 text-[12px] text-white/70">
          Mesh ready — stabilizing the geometry next.
        </div>
      )}
      <div className="border-t border-white/10 bg-black/20 p-0">
        <CommandInput
          onSend={send}
          disabled={streaming}
          loading={streaming}
          inputRef={inputRef}
          onUpload={(files) => { void handleUpload(files) }}
          attachments={attachments}
          onAttachmentRemove={removeAttachment}
        />
      </div>

      {previewUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setPreviewUrl(null)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            <img src={previewUrl} alt="concept preview" className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl" />
            <button
              className="absolute -right-2 -top-2 rounded-full border border-white/20 bg-black/60 px-2 py-1 text-xs text-white/80 hover:bg-black/70"
              onClick={() => setPreviewUrl(null)}
              aria-label="Close preview"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
