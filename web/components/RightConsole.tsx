"use client"
import ChatPanel from './ChatPanel'
import type { ContextSnapshot } from '@/lib/context'

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
  initialAttachments?: ContextSnapshot['attachments']
  onOrderCreated?: (id: string) => void
  onViewerFocus?: (kind: 'stl'|'glb'|'gltf'|'obj'|'toolpath', url: string, assetKind?: string | null, meta?: { assetId?: string | null; createdAt?: string | number | null }) => void
}) {
  const variant = (typeof process !== 'undefined' && (process.env.NEXT_PUBLIC_CONSOLE_VARIANT as 'classic'|'device')) || 'device'
  return (
    <aside className="flex w-[400px] flex-shrink-0 flex-col gap-4 h-[calc(100vh-2rem)] max-h-[calc(100vh-2rem)] overflow-hidden">
      <ChatPanel
        title="Design Your 3D Model"
        orderId={orderId}
        loadingSnapshot={loadingSnapshot}
        initialMessages={initialMessages}
        initialStatus={initialStatus}
        initialAttachments={initialAttachments}
        onOrderCreated={onOrderCreated}
        onViewerFocus={onViewerFocus}
        variant={variant}
      />
    </aside>
  )
}
