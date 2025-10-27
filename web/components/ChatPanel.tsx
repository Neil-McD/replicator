"use client"

import React, { useEffect, useRef, useState, useCallback } from "react"
import CommandInput from "@/components/CommandInput"
import QuoteCard from "@/components/QuoteCard"
import { authedFetch, getAccessToken } from "@/lib/clientAuth"
import { createOrder } from "@/lib/api"

export type AttachmentItem = {
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

export type ChatPanelProps = {
  orderId?: string | null
  title?: string
  loadingSnapshot?: boolean
  initialMessages?: { id: string; role: 'user'|'assistant'|'tool'; type?: string | null; content?: any; created_at?: string | null }[] | null
  initialStatus?: string | null
  initialAttachments?: AttachmentItem[] | null
  onOrderCreated?: (id: string)=>void
  onViewerFocus?: (kind: 'stl'|'glb'|'gltf'|'obj'|'toolpath', url: string, assetKind?: string | null, meta?: { assetId?: string | null; createdAt?: string | number | null })=>void
  variant?: 'classic'|'device'
}

type Msg =
  | { role: 'user'; text: string }
  | { role: 'assistant'; kind: 'text'; text: string }
  | { role: 'assistant'; kind: 'warning'; text: string }
  | { role: 'assistant'; kind: 'quote'; quote: any }

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
  const [messages, setMessages] = useState<Msg[]>([])
  const [attachments, setAttachments] = useState<AttachmentItem[]>(() => normalizeAttachments(_props.initialAttachments))
  const [streaming, setStreaming] = useState(false)
  const [orderId, setOrderId] = useState<string | null>(_props.orderId ?? null)

  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const postAbortRef = useRef<AbortController | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)

  const scrollToBottom = useCallback(() => {
    try { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) } catch {}
  }, [])

  useEffect(() => { scrollToBottom() }, [messages.length, scrollToBottom])

  useEffect(() => {
    if (!orderId) return
    void startBackgroundStream(orderId)
  }, [orderId])

  async function ensureOrder(): Promise<string> {
    if (orderId) return orderId
    const title = _props.title || ''
    const created = await createOrder(title)
    const id = created.order_id
    setOrderId(id)
    _props.onOrderCreated?.(id)
    void startBackgroundStream(id)
    return id
  }

  async function startBackgroundStream(id: string) {
    try {
      const token = await getAccessToken()
      const url = new URL(`/api/chat/stream`, window.location.origin)
      url.searchParams.set('orderId', id)
      if (token) url.searchParams.set('access_token', token)
      streamAbortRef.current?.abort()
      const ac = new AbortController()
      streamAbortRef.current = ac
      const resp = await fetch(url.toString(), { signal: ac.signal })
      if (!resp.ok || !resp.body) return
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = chunk.split("\n").find((l)=>l.startsWith('data: '))
          if (!line) continue
          try {
            const payload = JSON.parse(line.slice(6))
            handleEvent(payload)
          } catch {}
        }
      }
    } catch {}
  }

  function handleEvent(evt: any) {
    if (!evt) return
    const role = evt.role
    const type = evt.type
    const content = evt.content || {}
    if (role === 'assistant' && type === 'text' && typeof content.text === 'string') {
      setMessages((m) => [...m, { role: 'assistant', kind: 'text', text: content.text }])
    } else if (role === 'assistant' && type === 'warning' && typeof content.text === 'string') {
      setMessages((m) => [...m, { role: 'assistant', kind: 'warning', text: content.text }])
    } else if (role === 'assistant' && type === 'card.quote') {
      setMessages((m) => [...m, { role: 'assistant', kind: 'quote', quote: content }])
    }
  }

  async function send(text: string) {
    if (!text.trim()) return
    setMessages((m) => [...m, { role: 'user', text }])
    setStreaming(true)
    try {
      const id = await ensureOrder()
      postAbortRef.current?.abort()
      const ac = new AbortController()
      postAbortRef.current = ac
      const resp = await authedFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: id, message: text, attachments }),
        signal: ac.signal as any,
      })
      if (!resp.ok || !resp.body) return
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const line = chunk.split("\n").find((l)=>l.startsWith('data: '))
          if (!line) continue
          try {
            const payload = JSON.parse(line.slice(6))
            handleEvent(payload)
          } catch {}
        }
      }
    } finally {
      setStreaming(false)
      scrollToBottom()
    }
  }

  return (
    <div className="flex flex-1 h-full">
      <div className={`panel relative flex flex-1 min-h-[480px] h-full flex-col overflow-hidden p-0`}>
        <div className="border-b border-white/10 px-4 pt-3 pb-2 text-[11px] font-semibold tracking-widest">
          <div className="text-white/80">FABRICATOR CONSOLE</div>
        </div>
        <div ref={listRef} className="relative flex-1 space-y-3 overflow-y-auto no-scrollbar p-4">
          {/* Empty-state helper (centered only, no header pills) */}
          {messages.length === 0 && !streaming && (
            <div className="pointer-events-none absolute inset-0 z-10 grid place-content-center px-6">
              <div className="mx-auto max-w-[560px] text-center">
                <div className="space-y-20 text-[13px] leading-7">
                  <div className="flex flex-col items-center">
                    <span className="font-semibold text-tealGlow/80">Specify</span>
                    <span className="mt-0 text-white/60">Describe what you want to make.</span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="font-semibold text-tealGlow/80">Visualize</span>
                    <span className="mt-0 text-white/60">generate some concepts.</span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="font-semibold text-tealGlow/80">Materialize</span>
                    <span className="mt-0 text-white/60">make a 3D model.</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className="max-w-[92%]">
              <div className="rounded-xl px-3.5 py-3 border border-white/10 bg-white/5">
                <div className="mb-1 text-[11px] uppercase tracking-wider text-white/70">
                  {m.role === 'assistant' ? 'Atom' : 'Command'}
                </div>
                {m.role === 'assistant' && m.kind === 'quote' ? (
                  <QuoteCard
                    previewUrl={m.quote?.preview_url}
                    minutes={m.quote?.minutes}
                    grams={m.quote?.grams}
                    priceCents={m.quote?.price_cents}
                    totalCents={m.quote?.total_cents}
                    productCents={m.quote?.product_cents}
                    laborCents={m.quote?.labor_cents}
                    shippingCents={m.quote?.shipping_cents}
                    canPay={false}
                  />
                ) : (
                  <div className="text-sm leading-6">{(m as any).text}</div>
                )}
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
            inputRef={inputRef as any}
            onUpload={() => {}}
            attachments={attachments}
            onAttachmentRemove={() => {}}
          />
        </div>
      </div>
    </div>
  )
}
