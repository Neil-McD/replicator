"use client"
import ChatPanel from './ChatPanel'

export default function RightConsole({
  orderId,
  loadingSnapshot,
  initialMessages,
  initialStatus,
  initialAttachments,
  onOrderCreated,
  onViewerFocus,
}: {
  orderId?: string | null
  loadingSnapshot?: boolean
  initialMessages?: { id: string; role: 'user' | 'assistant' | 'tool'; type?: string | null; content?: any; created_at?: string | null }[]
  initialStatus?: string | null
  initialAttachments?: { asset_id: string; url: string; storage_url?: string | null; expires_at?: number | null; pending?: boolean | null; label?: string | null; name?: string | null; size?: number | null; content_type?: string | null }[]
  onOrderCreated?: (id: string) => void
  onViewerFocus?: (kind: 'stl'|'glb'|'gltf'|'obj'|'toolpath', url: string, assetKind?: string | null, meta?: { assetId?: string | null; createdAt?: string | number | null; storageUrl?: string | null; expiresAt?: number | null; metrics?: any }) => void
}) {
  const variant = (typeof process !== 'undefined' && (process.env.NEXT_PUBLIC_CONSOLE_VARIANT as 'classic'|'device')) || 'device'
  const normalizedAttachments = initialAttachments?.map((item) => ({
    assetId: item.asset_id,
    url: item.url,
    storageUrl: item.storage_url ?? null,
    expiresAt: item.expires_at ?? null,
    pending: item.pending ?? undefined,
    label: item.label ?? null,
    name: item.name ?? null,
    size: item.size ?? null,
    contentType: item.content_type ?? null,
  }))
  return (
    <aside className="flex w-[400px] flex-shrink-0 flex-col gap-4 h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] overflow-hidden">
      <ChatPanel
        title="Design Your 3D Model"
        orderId={orderId}
        loadingSnapshot={loadingSnapshot}
        initialMessages={initialMessages}
        initialStatus={initialStatus}
        initialAttachments={normalizedAttachments}
        onOrderCreated={onOrderCreated}
        onViewerFocus={onViewerFocus}
        variant={variant}
      />
    </aside>
  )
}
