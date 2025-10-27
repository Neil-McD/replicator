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
  const [messages, setMessages] = useState<Msg[]>([])
  const [attachments, setAttachments] = useState<AttachmentItem[]>(() => normalizeAttachments(_props.initialAttachments))
  const [orderId, setOrderId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [materializeStage, setMaterializeStage] = useState<'draft'|null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const sseRef = useRef<any | null>(null)
  const bcRef = useRef<BroadcastChannel | null>(null)
  const tabIdRef = useRef<string>(`tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
  const roleRef = useRef<'leader' | 'follower' | null>(null)
  const leaderIdRef = useRef<string | null>(null)
  const hbIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hbMissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const electionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [editTarget, setEditTarget] = useState<{ url: string } | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  function scrollToBottom() {
    try { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) } catch {}
  }

  useEffect(() => {
    const unsub = onAccessTokenChange(() => {})
    return () => {
      try { unsub?.() } catch {}
    }
  }, [])

  useEffect(() => {
    if (status) {
      // keep phase in sync if server status changes
      const norm = String(status).toLowerCase()
      if (norm.includes('visual') || norm === 'concept') setPhase('Visualize')
      else if (norm === 'quoted' || norm === 'working' || norm === 'materialized' || norm === 'purchased' || norm === 'fulfilling') setPhase('Materialize')
      else setPhase('Specify')
    }
  }, [status])

  async function send(text: string) {
    if (!text.trim()) return
    setMessages((m) => [...m, { role: 'user', text }])
    setStreaming(true)
    try {
      // ensure order exists
      let id = orderId
      if (!id) {
        const res = await createOrder({ title: _props.title || undefined })
        id = res?.id || null
        if (id) { setOrderId(id); _props.onOrderCreated?.(id) }
      }
      if (!id) throw new Error('order_not_created')

      const token = await getAccessToken()
      const resp = await fetch(`/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
        body: JSON.stringify({ orderId: id, message: text, attachments }),
      })
      if (!resp.ok) throw new Error('chat_failed')
      const reader = resp.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      let done = false
      while (!done) {
        const { value, done: d } = await reader.read()
        done = d
        if (value) {
          const chunk = decoder.decode(value, { stream: true })
          setMessages((m) => [...m, { role: 'assistant', text: chunk }])
        }
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', text: 'Something went wrong.' }])
    } finally {
      setStreaming(false)
      scrollToBottom()
    }
  }

  useEffect(() => { scrollToBottom() }, [messages.length])

  return (
    <div className="flex flex-1 h-full">
      <AuthModal
        open={false}
        onClose={() => {}}
        onAuthenticated={() => {}}
      />
      <div
        className={`panel relative flex flex-1 min-h-[480px] h-full flex-col overflow-hidden p-0`}
      >
        <div className="border-b border-white/10 px-4 pt-3 pb-2 text-[11px] font-semibold tracking-widest">
          <div className="text-white/80">FABRICATOR CONSOLE</div>
        </div>
        <div ref={listRef} className="relative flex-1 space-y-3 overflow-y-auto no-scrollbar p-4">
          {/* Empty-state helper (centered only, no header pills) */}
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

          {/* Example message rendering */}
          {messages.map((m, i) => (
            <div key={i} className="max-w-[92%]">
              <div className="rounded-xl px-3.5 py-3 border border-white/10 bg-white/5">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-white/70">
                  {m.role === 'assistant' ? 'Atom' : 'Command'}
                </div>
                <div className="text-sm leading-6">{m.text}</div>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="border-t border-white/10 bg-black/20 p-0">
          <CommandInput
            onSend={send}
            disabled={streaming}
            loading={streaming}
            inputRef={inputRef}
            onUpload={() => {}}
            attachments={attachments}
            onAttachmentRemove={() => {}}
          />
        </div>
      </div>
    </div>
  )
}
