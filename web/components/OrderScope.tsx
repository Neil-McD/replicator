"use client"
import { createContext, useContext, useEffect, useMemo, useReducer, useCallback, useRef } from 'react'

type AbortRegistry = {
  add: (c: AbortController) => void
  remove: (c: AbortController) => void
  abortAll: () => void
}

const OrderAbortContext = createContext<AbortRegistry | null>(null)

type OrderState = {
  orderId: string | null
  status: string | null
  orderVersion: number
  quote: any | null
  exportGeneration: number | null
  sliceGeneration: number | null
  transformAssetId: string | null
}

type OrderStateUpdate = {
  status?: string | null
  orderVersion?: number | null
  quote?: any | null
  exportGeneration?: number | null
  sliceGeneration?: number | null
  transformAssetId?: string | null
}

type OrderStateAction =
  | { type: 'reset'; payload: OrderState }
  | { type: 'apply'; payload: OrderStateUpdate }

const OrderStateContext = createContext<OrderState | undefined>(undefined)
const OrderStateActionsContext = createContext<((payload: OrderStateUpdate) => void) | undefined>(undefined)

function normalizeVersion(input: number | null | undefined): number | undefined {
  if (typeof input !== 'number') return undefined
  if (!Number.isFinite(input)) return undefined
  return input
}

function mergeOrderState(state: OrderState, patch: OrderStateUpdate): OrderState {
  const incomingVersion = normalizeVersion(patch.orderVersion)

  if (incomingVersion !== undefined) {
    if (incomingVersion < state.orderVersion) {
      return state
    }
    if (incomingVersion > state.orderVersion) {
      return {
        ...state,
        status: patch.status ?? null,
        quote: patch.quote ?? null,
        exportGeneration: patch.exportGeneration ?? null,
        sliceGeneration: patch.sliceGeneration ?? null,
        transformAssetId: patch.transformAssetId ?? null,
        orderVersion: incomingVersion,
      }
    }

    const next: OrderState = { ...state }
    if (patch.status !== undefined && patch.status !== state.status) next.status = patch.status
    if (patch.quote !== undefined) next.quote = patch.quote
    if (patch.exportGeneration !== undefined) next.exportGeneration = patch.exportGeneration
    if (patch.sliceGeneration !== undefined) next.sliceGeneration = patch.sliceGeneration
    if (patch.transformAssetId !== undefined) next.transformAssetId = patch.transformAssetId
    return next
  }

  const next: OrderState = { ...state }
  if (state.status == null && patch.status != null) next.status = patch.status
  if (patch.quote != null) next.quote = patch.quote
  if (patch.exportGeneration != null) next.exportGeneration = patch.exportGeneration
  if (patch.sliceGeneration != null) next.sliceGeneration = patch.sliceGeneration
  if (patch.transformAssetId != null) next.transformAssetId = patch.transformAssetId
  return next
}

function orderStateReducer(state: OrderState, action: OrderStateAction): OrderState {
  switch (action.type) {
    case 'reset':
      return action.payload
    case 'apply':
      return mergeOrderState(state, action.payload)
    default:
      return state
  }
}

type OrderStateProviderProps = {
  orderId: string | null
  initialStatus: string | null
  initialQuote: any | null
  initialVersion: number | null
  children: React.ReactNode
}

function OrderStateProvider({ orderId, initialStatus, initialQuote, initialVersion, children }: OrderStateProviderProps) {
  const initialState = useMemo<OrderState>(() => ({
    orderId,
    status: initialStatus ?? null,
    orderVersion: initialVersion ?? 0,
    quote: initialQuote ?? null,
    exportGeneration: null,
    sliceGeneration: null,
    transformAssetId: null,
  }), [orderId, initialStatus, initialQuote, initialVersion])

  const [state, dispatch] = useReducer(orderStateReducer, initialState)

  const prevOrderIdRef = useRef<string | null>(orderId)

  useEffect(() => {
    if (orderId !== prevOrderIdRef.current) {
      prevOrderIdRef.current = orderId
      dispatch({ type: 'reset', payload: initialState })
    }
  }, [orderId, initialState])

  const applyServerUpdate = useCallback((payload: OrderStateUpdate) => {
    dispatch({ type: 'apply', payload })
  }, [])

  return (
    <OrderStateContext.Provider value={state}>
      <OrderStateActionsContext.Provider value={applyServerUpdate}>{children}</OrderStateActionsContext.Provider>
    </OrderStateContext.Provider>
  )
}

export function useOrderState(): OrderState {
  const ctx = useContext(OrderStateContext)
  if (!ctx) {
    throw new Error('useOrderState must be used within an OrderStateProvider')
  }
  return ctx
}

export function useOrderStateActions() {
  const ctx = useContext(OrderStateActionsContext)
  if (!ctx) {
    throw new Error('useOrderStateActions must be used within an OrderStateProvider')
  }
  return { applyServerUpdate: ctx }
}

function createAbortRegistry(): AbortRegistry {
  const set = new Set<AbortController>()
  return {
    add: (c) => { try { set.add(c) } catch {} },
    remove: (c) => { try { set.delete(c) } catch {} },
    abortAll: () => {
      for (const c of Array.from(set)) {
        try { c.abort() } catch {}
        set.delete(c)
      }
    },
  }
}

export function useOrderAbortRegistry() {
  const ctx = useContext(OrderAbortContext)
  return ctx
}

export default function OrderScope({ orderId, initialStatus, initialQuote, initialVersion, children }: { orderId?: string | null; initialStatus?: string | null; initialQuote?: any | null; initialVersion?: number | null; children: React.ReactNode }) {
  const registry = useMemo(() => createAbortRegistry(), [orderId])

  useEffect(() => {
    return () => {
      try { registry.abortAll() } catch {}
    }
  }, [registry])

  return (
    <OrderAbortContext.Provider value={registry}>
      <OrderStateProvider
        key={orderId ?? 'none'}
        orderId={orderId ?? null}
        initialStatus={initialStatus ?? null}
        initialQuote={initialQuote ?? null}
        initialVersion={initialVersion ?? 0}
      >
        {children}
      </OrderStateProvider>
    </OrderAbortContext.Provider>
  )
}
