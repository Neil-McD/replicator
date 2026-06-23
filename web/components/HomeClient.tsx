"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import Stage from '@/components/Stage'
import RightConsole from '@/components/RightConsole'
import LeftRail from '@/components/LeftRail'
import { useWorkspace } from '@/components/workspace/WorkspaceProvider'
import AuthModal from '@/components/AuthModal'
import { supabaseBrowser } from '@/lib/supabaseClient'
import OrderScope from '@/components/OrderScope'
// OrderScope is optional state scaffolding. To avoid client-runtime
// issues in Preview while we stabilize, render without it.

export default function HomeClient() {
  const {
    orderId,
    lastVisitedOrderId,
    orderRevision,
    sessions,
    loadingSnapshot,
    initialMessages,
    initialStatus,
    initialQuote,
    initialVersion,
    initialAttachments,
    localPreview,
    selectOrder,
    startNewOrder,
    handleOrderCreated,
    handleViewerFocus,
    resetWorkspace,
    ensureSnapshotFresh,
  } = useWorkspace()

  const [railExpanded, setRailExpanded] = useState<boolean>(false)
  const [railLocked, setRailLocked] = useState<boolean>(false)
  const railContainerRef = useRef<HTMLDivElement | null>(null)
  const showOperator = typeof process !== 'undefined' && Boolean(process.env.NEXT_PUBLIC_SHOW_OPERATOR)

  // Proactive auth modal: prompt unauthenticated users on arrival
  const [authOpen, setAuthOpen] = useState<boolean>(false)
  useEffect(() => {
    let mounted = true
    supabaseBrowser.auth.getUser().then(({ data }) => {
      if (!mounted) return
      const hasUser = !!data?.user
      setAuthOpen(!hasUser)
    })
    const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
      const hasUser = !!session?.user
      setAuthOpen(!hasUser)
    })
    return () => { mounted = false; sub.subscription.unsubscribe() }
  }, [])

  const handleStartNew = useCallback(() => {
    setRailExpanded(false)
    setRailLocked(false)
    void startNewOrder()
  }, [startNewOrder])

  const handleSessionSelect = useCallback(
    (id: string) => {
      setRailExpanded(false)
      setRailLocked(false)
      selectOrder(id)
    },
    [selectOrder]
  )

  const handleSessionHover = useCallback(
    (id: string) => {
      // Predictively refresh snapshot in background to hydrate SW capsule
      void ensureSnapshotFresh(id, { apply: false, showSpinner: false })
    },
    [ensureSnapshotFresh]
  )

  const handleRailClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (railLocked) return
      const target = event.target as HTMLElement | null
      // Ignore clicks originating from inline rename UI or item menus
      if (target?.closest('[data-rail-item-menu]')) return
      const actionEl = target?.closest('[data-rail-action]') as HTMLElement | null
      if (actionEl?.dataset.railAction === 'new') {
        handleStartNew()
        return
      }
      if (target?.closest('[data-rail-nav="1"]')) {
        return
      }
      if (target?.closest('[data-session-item="1"]')) {
        return
      }
      setRailExpanded((prev) => !prev)
    },
    [handleStartNew, railLocked]
  )

  useEffect(() => {
    if (!railExpanded) return
    function handleClick(event: MouseEvent) {
      const target = event.target as Node
      if (railContainerRef.current?.contains(target)) return
      if (!railLocked) setRailExpanded(false)
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!railLocked) setRailExpanded(false)
      }
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [railExpanded, railLocked])

  useEffect(() => {
    if (!orderId) return
    void ensureSnapshotFresh(orderId, { apply: true })
  }, [orderId, ensureSnapshotFresh])

  const stagePreview = useMemo(() => localPreview, [localPreview])

  return (
    <main className="flex min-h-screen gap-4 p-4">
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthenticated={() => setAuthOpen(false)}
        title="Sign in to start"
      />
      <div
        ref={railContainerRef}
        className={`relative h-[calc(100vh-2rem)] ${railExpanded ? 'cursor-default' : 'cursor-ew-resize'}`}
        onClick={handleRailClick}
      >
        <LeftRail
          showOperator={showOperator}
          onStartNew={handleStartNew}
          expanded={railExpanded}
          sessions={sessions}
          activeSessionId={orderId}
          lastVisitedSessionId={lastVisitedOrderId}
          onSessionSelect={handleSessionSelect}
          onSessionHover={handleSessionHover}
          onRenamingChange={setRailLocked}
        />
      </div>
      <OrderScope
        orderId={orderId}
        initialStatus={initialStatus ?? null}
        initialQuote={initialQuote ?? null}
        initialVersion={initialVersion ?? 0}
      >
        <div className="flex flex-1 min-w-0 gap-4">
          <div className="flex-1 min-w-0">
            <Stage
              key={orderId || 'none'}
              orderId={orderId}
              orderRevision={orderRevision}
              localPreview={stagePreview}
              onResetWorkspace={resetWorkspace}
            />
          </div>
          <RightConsole
            key={orderId || 'none'}
            orderId={orderId}
            loadingSnapshot={loadingSnapshot}
            initialMessages={initialMessages ?? undefined}
            initialStatus={initialStatus ?? undefined}
            initialAttachments={initialAttachments?.map((a: any) => ({
              assetId: a.asset_id,
              url: a.url,
              storageUrl: a.storage_url,
              expiresAt: a.expires_at,
              pending: a.pending,
              label: a.label,
              name: a.name,
              size: a.size,
              contentType: a.content_type,
            })) ?? undefined}
            onOrderCreated={handleOrderCreated}
            onViewerFocus={handleViewerFocus}
          />
        </div>
      </OrderScope>
    </main>
  )
}
