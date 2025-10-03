"use client"
import { createContext, useContext, useEffect, useMemo } from 'react'

type AbortRegistry = {
  add: (c: AbortController) => void
  remove: (c: AbortController) => void
  abortAll: () => void
}

const OrderAbortContext = createContext<AbortRegistry | null>(null)

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

export default function OrderScope({ orderId, children }: { orderId?: string | null; children: React.ReactNode }) {
  const registry = useMemo(() => createAbortRegistry(), [orderId])

  useEffect(() => {
    return () => {
      try { registry.abortAll() } catch {}
    }
  }, [registry])

  return (
    <OrderAbortContext.Provider value={registry}>
      {children}
    </OrderAbortContext.Provider>
  )
}

