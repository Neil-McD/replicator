"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import Stage from '@/components/Stage'
import RightConsole from '@/components/RightConsole'
import LeftRail from '@/components/LeftRail'
import { useWorkspace } from '@/components/workspace/WorkspaceProvider'
import OrderScope from '@/components/OrderScope'

export default function HomeClient() {
  const {
    orderId,
    lastVisitedOrderId,
    orderRevision,
    sessions,
    loadingSnapshot,
    initialMessages,
    initialStatus,
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
      <div className="flex flex-1 min-w-0 gap-4">
        <OrderScope orderId={orderId}>
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
            initialAttachments={initialAttachments ?? undefined}
            onOrderCreated={handleOrderCreated}
            onViewerFocus={handleViewerFocus}
          />
        </OrderScope>
      </div>
    </main>
  )
}
