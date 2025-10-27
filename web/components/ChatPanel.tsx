"use client"

import React, { useEffect, useRef, useState, useCallback } from "react"
import CommandInput from "@/components/CommandInput"

// Minimal ChatPanel used by RightConsole. No OrderScope hooks
// to ensure Vercel pre-render does not evaluate unavailable exports.

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

type Msg = { role: 'user'|'assistant'; text?: string }

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
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const scrollToBottom = useCallback(() => {
    try { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) } catch {}
  }, [])

  useEffect(() => { scrollToBottom() }, [messages.length, scrollToBottom])

  async function send(text: string) {
    if (!text.trim()) return
    setMessages((m) => [...m, { role: 'user', text }])
    setStreaming(true)
    try {
      // Minimal echo assistant; server orchestration handled elsewhere
      await new Promise((r) => setTimeout(r, 200))
      setMessages((m) => [...m, { role: 'assistant', text: 'Noted.' }])
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
