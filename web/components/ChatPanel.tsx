"use client"
import React, { useEffect, useRef, useState, useCallback } from "react"
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
      parts.push(`file ${(sizeBytes / (1024 * 1024)).toF
...