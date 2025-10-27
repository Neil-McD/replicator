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
  // Track which parent image ids already have a f
[...FULL_FILE_CONTENT_TRUNCATED_FOR BREVITY...]
