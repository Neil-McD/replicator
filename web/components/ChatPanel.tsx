"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOrderState, useOrderStateActions } from '@/components/OrderScope'
import * as THREE from 'three'
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
// @ts-ignore
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import ViewerControls from './ViewerControls'
import { isPurchaseReady, isQuoteFreshForCurrent } from '@/lib/orderFreshness'
import { shouldAdoptSizedTarget } from '@/lib/sizeUtils'
import BuyModal from './BuyModal'
// @ts-ignore
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
// @ts-ignore
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
// @ts-ignore
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
// @ts-ignore
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
// @ts-ignore
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { authedFetch, getAccessToken, onAccessTokenChange } from '@/lib/clientAuth'

// Debug flag; enable via localStorage.setItem('dbg.viewer', '1') in dev
const DEBUG_VIEWER = typeof window !== 'undefined' && !!window.localStorage.getItem('dbg.viewer')
function dbg(...args: any[]) {
  if (DEBUG_VIEWER) {
    try { console.log('[viewer]', ...args) } catch {}
  }
}

const BUILD_VOLUME_X_MM = Number(process.env.NEXT_PUBLIC_BUILD_VOLUME_X_MM || '256')
const BUILD_VOLUME_Y_MM = Number(process.env.NEXT_PUBLIC_BUILD_VOLUME_Y_MM || '256')
const BUILD_VOLUME_Z_MM = Number(process.env.NEXT_PUBLIC_BUILD_VOLUME_Z_MM || '256')
const BUILD_VOLUME_MARGIN_MM = Number(process.env.NEXT_PUBLIC_BUILD_VOLUME_MARGIN_MM || '2')
const SIZE_STORAGE_PREFIX = 'replicator:size:'
const SIZE_STORAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000

const STL_BUFFER_CACHE = new Map<string, ArrayBuffer>()
const STL_BUFFER_LIMIT = 4
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VIEWER_EXPECT_KEY_PREFIX = 'replicator:expects_mesh:'

// Simple in-memory geometry stash keyed by canonical storage_url (or sha-based URL)
type Stashed = { geometry: THREE.BufferGeometry; at: number }
const GEOM_STASH = new Map<string, Stashed>()
const GEOM_STASH_LIMIT = 3
function stashGeometry(key: string | null, geom: THREE.BufferGeometry) {
  if (!key) return
  GEOM_STASH.set(key, { geometry: geom, at: Date.now() })
  if (GEOM_STASH.size > GEOM_STASH_LIMIT) {
    const entries = Array.from(GEOM_STASH.entries())
    entries.sort((a, b) => a[1].at - b[1].at)
    const toDelete = entries.slice(0, Math.max(0, entries.length - GEOM_STASH_LIMIT))
    for (const [k] of toDelete) {
      try { GEOM_STASH.delete(k) } catch {}
    }
  }
}
function getStashedGeometry(key: string | null): THREE.BufferGeometry | null {
  if (!key) return null
  const hit = GEOM_STASH.get(key)
  if (hit) { hit.at = Date.now(); return hit.geometry }
  return null
}

const CANCELLABLE_ORDER_STATUSES = new Set([
  'concept',
  'working',
  'materialized',
])

const FAILURE_NOTICE_MAP: Record<string, string> = {
  failed: 'Processing failed — review the timeline for details, adjust the model, then retry.',
  needs_review: 'This job needs a manual review before it can continue.',
}

const FAILURE_NOTICE_VALUES = new Set(Object.values(FAILURE_NOTICE_MAP))

type CardTone = 'info' | 'success' | 'warning'

const CARD_TONE_CLASSES: Record<CardTone, string> = {
  info: 'border-white/10 bg-white/5 text-textPrimary',
  success: 'border-teal/25 bg-teal/10 text-teal',
  warning: 'border-warning/30 bg-warning/10 text-warning',
}
type StageCardStatus = { tone: CardTone; primary: string; secondary: string | null }

type PhaseKey = 'visualize' | 'materialize' | 'stabilize' | 'authorize' | 'fabricate' | 'complete'

const ORDER_PHASES = [
  { key: 'visualize', label: 'Visualizing', statuses: ['empty', 'chat', 'concept'] },
  { key: 'materialize', label: 'Materializing', statuses: ['working'] },
  { key: 'stabilize', label: 'Geometry Ready', statuses: ['materialized'] },
  { key: 'authorize', label: 'Authorizing', statuses: ['quoted'] },
  { key: 'fabricate', label: 'Fabricating', statuses: ['purchased', 'fulfilling'] },
  { key: 'complete', label: 'Complete', statuses: ['done'] },
] as const satisfies ReadonlyArray<{ key: PhaseKey; label: string; statuses: readonly string[] }>

const STATUS_TO_PHASE = (() => {
  const map = new Map<string, PhaseKey>()
  for (const phase of ORDER_PHASES) {
    for (const status of phase.statuses) {
      map.set(status, phase.key)
    }
  }
  return map
})()

const FAILURE_STATUS_TO_PHASE: Record<string, PhaseKey> = {
  failed: 'materialize',
  needs_review: 'stabilize',
  cancelled: 'visualize',
}

const FAILURE_STATUS_SET = new Set<string>([
  ...Object.keys(FAILURE_STATUS_TO_PHASE),
  ...Object.keys(FAILURE_NOTICE_MAP),
])

function cacheStlBuffer(key: string, buffer: ArrayBuffer) {
  if (!key) return
  STL_BUFFER_CACHE.set(key, buffer.slice(0))
  if (STL_BUFFER_CACHE.size > STL_BUFFER_LIMIT) {
    const oldest = STL_BUFFER_CACHE.keys().next().value
    if (typeof oldest !== 'undefined') {
      STL_BUFFER_CACHE.delete(oldest)
    }
  }
}

function getCachedStlBuffer(key: string | null): ArrayBuffer | null {
  if (!key) return null
  return STL_BUFFER_CACHE.get(key) || null
}

// Persistent Cache Storage for STL bytes (stale-while-revalidate)
async function getStlCache(): Promise<Cache | null> {
  try {
    if (typeof window === 'undefined') return null
    return await caches.open('replicator:stl')
  } catch {
    return null
  }
}

// ... (unchanged code above this comment)
      <div className="border-b border-white/10 px-4 pt-3 pb-2 text-[11px] font-semibold tracking-widest">
        <div className="text-white/80">FABRICATOR CONSOLE</div>
      </div>
      <div ref={listRef} className="relative flex-1 space-y-3 overflow-y-auto no-scrollbar p-4">
        {/* Empty-state helper: brief 3-step guidance (centered only, no header pills) */}
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
