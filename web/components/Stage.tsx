"use client"
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
// @ts-ignore
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
// @ts-ignore
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import ViewerControls from './ViewerControls'
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
  'visualizing',
  'materializing',
  'generating',
  'repairing',
  'fabrication_requested',
  'exporting',
  'slicing',
])

const FAILURE_NOTICE_MAP: Record<string, string> = {
  generate_failed: 'Concept-to-mesh failed — tweak the prompt or upload a reference model and try again.',
  repair_failed: 'Mesh repair failed — adjust the concept or upload a cleaner STL/OBJ.',
  slice_failed: 'Slicing failed — check thin walls or resize the mesh, then retry.',
  dispatch_failed: 'Dispatch to the printer failed — verify the Bambu queue and retry when ready.',
  needs_review: 'This job needs a manual review before it can continue.',
}

const FAILURE_NOTICE_VALUES = new Set(Object.values(FAILURE_NOTICE_MAP))

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
    // @ts-ignore
    if (!('caches' in window)) return null
    return await caches.open('replicator-stl-v1')
  } catch {
    return null
  }
}

async function readStlFromPersistentCache(storageUrl: string | null): Promise<ArrayBuffer | null> {
  if (!storageUrl) return null
  const cache = await getStlCache()
  if (!cache) return null
  try {
    const req = new Request(storageUrl, { method: 'GET' })
    const res = await cache.match(req)
    if (!res) return null
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (!ct.includes('stl') && !ct.includes('application/octet-stream')) {
      // Accept anyway; we only care about bytes
    }
    const ab = await res.arrayBuffer()
    try {
      // Update LRU access time
      if (typeof window !== 'undefined') {
        const raw = window.localStorage.getItem('replicator:stl:lru')
        const m = raw ? (JSON.parse(raw) as Record<string, number>) : {}
        if (storageUrl) m[storageUrl] = Date.now()
        window.localStorage.setItem('replicator:stl:lru', JSON.stringify(m))
      }
    } catch {}
    return ab
  } catch {
    return null
  }
}

async function writeStlToPersistentCache(storageUrl: string | null, buffer: ArrayBuffer): Promise<void> {
  if (!storageUrl) return
  const cache = await getStlCache()
  if (!cache) return
  try {
    const req = new Request(storageUrl, { method: 'GET' })
    const res = new Response(buffer.slice(0), {
      headers: { 'Content-Type': 'application/sla', 'Cache-Control': 'public, max-age=31536000, immutable' },
    })
    await cache.put(req, res)
    // LRU record and prune
    try {
      if (typeof window !== 'undefined' && storageUrl) {
        const raw = window.localStorage.getItem('replicator:stl:lru')
        const m = raw ? (JSON.parse(raw) as Record<string, number>) : {}
        m[storageUrl] = Date.now()
        window.localStorage.setItem('replicator:stl:lru', JSON.stringify(m))
      }
      const requests = await cache.keys()
      const limit = 12
      if (requests.length > limit) {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem('replicator:stl:lru') : null
        const m = raw ? (JSON.parse(raw) as Record<string, number>) : {}
        const entries = requests.map((r) => ({ url: r.url, at: Number(m[r.url] || 0) }))
        entries.sort((a, b) => a.at - b.at)
        const toDelete = entries.slice(0, Math.max(0, entries.length - limit))
        for (const e of toDelete) {
          try { await cache.delete(e.url) } catch {}
          delete m[e.url]
        }
        if (typeof window !== 'undefined') window.localStorage.setItem('replicator:stl:lru', JSON.stringify(m))
      }
    } catch {}
  } catch {
    // ignore cache write failures
  }
}


type AllowedAssetKind =
  | 'repaired_sized_stl'
  | 'repaired_stl'
  | 'upload_stl'
  | 'upload_obj'
  | 'upload_glb'
  | 'upload_gltf'
  | 'proxy_stl'
  | 'raw_stl'
  | 'raw_glb'
  | 'raw_obj'
  | 'raw_gltf'

const ALLOWED_ASSET_KINDS = new Set<AllowedAssetKind>([
  'repaired_sized_stl',
  'repaired_stl',
  'upload_stl',
  'upload_obj',
  'upload_glb',
  'upload_gltf',
  'proxy_stl',
  'raw_stl',
  'raw_glb',
  'raw_obj',
  'raw_gltf',
])

const KIND_PRIORITY: Record<AllowedAssetKind, number> = {
  repaired_sized_stl: 4,
  repaired_stl: 3,
  proxy_stl: 2,
  upload_stl: 1,
  upload_obj: 1,
  upload_glb: 1,
  upload_gltf: 1,
  raw_stl: 0,
  raw_glb: 0,
  raw_obj: 0,
  raw_gltf: 0,
}

const MODEL_FILE_EXTS = ['.stl', '.obj', '.glb', '.gltf']
const MODEL_MIME_PREFIX = /^model\//
const MODEL_MIME_ALLOW = new Set([
  'application/sla',
  'application/vnd.ms-pki.stl',
  'application/octet-stream',
])

type ModelDragIntent = 'yes' | 'no' | 'maybe'

function isModelFilename(name?: string | null) {
  if (!name) return false
  const lower = name.toLowerCase()
  return MODEL_FILE_EXTS.some((ext) => lower.endsWith(ext))
}

function isModelFileLike(file: File | null | undefined) {
  if (!file) return false
  const type = (file.type || '').toLowerCase()
  if (MODEL_MIME_PREFIX.test(type)) return true
  if (MODEL_MIME_ALLOW.has(type)) {
    return type === 'application/octet-stream' ? isModelFilename(file.name) : true
  }
  return isModelFilename(file.name)
}

function resolveModelDragIntent(dt: DataTransfer | null): ModelDragIntent {
  if (!dt) return 'no'
  let sawFile = false
  try {
    if (dt.items && dt.items.length) {
      for (const item of Array.from(dt.items)) {
        if (!item || item.kind !== 'file') continue
        sawFile = true
        const type = (item.type || '').toLowerCase()
        if (MODEL_MIME_PREFIX.test(type)) return 'yes'
        if (MODEL_MIME_ALLOW.has(type) && type !== 'application/octet-stream') {
          return 'yes'
        }
        if (!type || type === 'application/octet-stream') {
          const file = item.getAsFile()
          if (file) {
            if (isModelFileLike(file)) return 'yes'
          } else {
            return 'maybe'
          }
        }
      }
    }
  } catch {
    return 'maybe'
  }
  const files = dt.files
  if (files && files.length) {
    sawFile = true
    for (const file of Array.from(files)) {
      if (isModelFileLike(file)) return 'yes'
    }
  }
  if (!sawFile) {
    try {
      const types = Array.from(dt.types || [])
      if (types.includes('Files')) return 'maybe'
    } catch {
      return 'maybe'
    }
  }
  return 'no'
}

type StageCandidate = {
  url: string
  ext?: string | null
  kind?: 'stl' | 'glb' | 'gltf' | 'obj' | 'toolpath'
  assetKind?: string | null
  assetId?: string | null
  createdAt?: string | number | null
  source?: 'sse' | 'poll' | 'manual' | 'rehydrate'
  storageUrl?: string | null
  expiresAt?: number | null
  meta?: any
}

type LocalPreview = StageCandidate | null
type FeatureKind = 'perimeter' | 'infill' | 'support'
type ToolpathSegment = { kind: FeatureKind; positions: Float32Array }
type ToolpathLayer = { index: number; z: number; segments: ToolpathSegment[] }
type CameraFocusOptions = { mode?: 'fit' | 'maintain' }
type SizeStatus = 'clean' | 'dirty' | 'processing'

export default function Stage({
  orderId,
  orderRevision,
  localPreview,
  onResetWorkspace,
}: {
  orderId?: string | null
  orderRevision?: number
  localPreview?: LocalPreview
  onResetWorkspace?: (orderId?: string | null) => void
}) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [modelUrl, setModelUrl] = useState<string | null>(null)
  const [modelExt, setModelExt] = useState<string | null>(null)
  const modelUrlRef = useRef<string | null>(null)
  const modelExtRef = useRef<string | null>(null)
  const [sizeOpen, setSizeOpen] = useState<boolean>(false)
  const DEFAULT_LONGEST = 100
  const [displayLongest, setDisplayLongest] = useState<number>(DEFAULT_LONGEST)
  const [sizingActive, setSizingActive] = useState<boolean>(false)
  const [savingSize, setSavingSize] = useState<boolean>(false)
  const [isDragging, setIsDragging] = useState(false)
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const controlsRef = useRef<any>(null)
  const objectRef = useRef<THREE.Object3D | null>(null)
  const loaderRef = useRef<any>(null)
  const loadModelRef = useRef<(url: string) => void>(() => {})
  const loadSeqRef = useRef<number>(0)
  const stlAbortRef = useRef<AbortController | null>(null)
  const parseWorkerRef = useRef<Worker | null>(null)
  const baseScaleRef = useRef<THREE.Vector3 | null>(null)
  const baseMaxDimRef = useRef<number | null>(null)
  const pendingInitialPlacementRef = useRef<boolean>(false)
  const committedLongestRef = useRef<number | null>(null)
  const workerLongestRef = useRef<number | null>(null)
  const sizingActiveRef = useRef<boolean>(false)
  const [hasModel, setHasModel] = useState<boolean>(false)
  const [printReadyUrl, setPrintReadyUrl] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [previewOverlayUrl, setPreviewOverlayUrl] = useState<string | null>(null)
  const [canPrepareStl, setCanPrepareStlState] = useState<boolean>(false)
  const canPrepareStlRef = useRef<boolean>(false)
  const basePrepareRef = useRef<boolean>(false)
  const [hasPrintableBase, setHasPrintableBase] = useState<boolean>(false)
  const pendingSizeRef = useRef<boolean>(false)
  const [sizePendingExport, setSizePendingExport] = useState<boolean>(false)
  const recomputePrepareAbility = useCallback(() => {
    const next = basePrepareRef.current && !pendingSizeRef.current && sizeStatusRef.current === 'clean'
    setCanPrepareStlState((prev) => {
      if (prev === next) return prev
      canPrepareStlRef.current = next
      return next
    })
  }, [])
  const setBasePrepare = useCallback((value: boolean) => {
    basePrepareRef.current = value
    setHasPrintableBase(value)
    recomputePrepareAbility()
  }, [recomputePrepareAbility])
  const setPendingSize = useCallback((value: boolean) => {
    pendingSizeRef.current = value
    setSizePendingExport(value)
    setPendingNeedsStl(value)
    recomputePrepareAbility()
  }, [recomputePrepareAbility])
  const [preparingStl, setPreparingStl] = useState<boolean>(false)
  const [addingToStore, setAddingToStore] = useState<boolean>(false)
  const [orderStatus, setOrderStatus] = useState<string | null>(null)
  const orderStatusRef = useRef<string | null>(null)
  const [waitingForMesh, setWaitingForMesh] = useState<boolean>(false)
  const [expectsMesh, setExpectsMeshState] = useState<boolean>(false)
  const accessTokenRef = useRef<string | null>(null)
  const cancelRequestRef = useRef<boolean>(false)
  const pollRef = useRef<() => Promise<void> | void>(() => {})
  // Orientation helpers exposed via refs so buttons can call them
  const rotateAndSeatRef = useRef<(axis: 'x'|'y'|'z', n?: number)=>void>(() => {})
  const uprightRef = useRef<()=>void>(() => {})
  // Track which asset we’ve loaded to avoid reloads on re-signed URLs
  const currentAssetIdRef = useRef<string | null>(null)
  const currentAssetKeyRef = useRef<string | null>(null)
  const currentAssetCreatedAtRef = useRef<number | null>(null)
  const currentKindRef = useRef<AllowedAssetKind | null>(null)
  const currentAssetInfoRef = useRef<{ kind?: string | null; meta?: any } | null>(null)
  const clearSceneRef = useRef<() => void>(() => {})
  const toolpathWorkerRef = useRef<Worker | null>(null)
  const toolpathGroupRef = useRef<THREE.Group | null>(null)
  const toolMaterialsRef = useRef<Record<FeatureKind, THREE.LineBasicMaterial> | null>(null)
  const [toolpathLayers, setToolpathLayers] = useState<ToolpathLayer[]>([])
  const [toolpathMode, setToolpathMode] = useState<boolean>(false)
  const [toolLayerIndex, setToolLayerIndex] = useState<number>(0)
  const [toolVisibility, setToolVisibility] = useState<{ perimeter: boolean; infill: boolean; support: boolean }>({ perimeter: true, infill: true, support: true })
  const [toolpathLoading, setToolpathLoading] = useState<boolean>(false)
  const [toolpathError, setToolpathError] = useState<string | null>(null)
  const [buyOpen, setBuyOpen] = useState<boolean>(false)
  const [awaitingTransform, setAwaitingTransform] = useState<boolean>(false)
  const toolpathBBoxRef = useRef<{ min: [number, number, number]; max: [number, number, number] } | null>(null)
  const currentToolpathAssetIdRef = useRef<string | null>(null)
  const currentToolpathStorageUrlRef = useRef<string | null>(null)
  const currentAssetStorageUrlRef = useRef<string | null>(null)
  const [toolpathAsset, setToolpathAsset] = useState<{ id: string; url: string } | null>(null)
  const toolpathAssetRef = useRef<{ id: string; url: string } | null>(null)
  const pendingToolpathAssetIdRef = useRef<string | null>(null)
  const awaitingTransformRef = useRef<boolean>(false)
  const awaitingTransformTimerRef = useRef<number | null>(null)
  const cameraOffsetRef = useRef<THREE.Vector3 | null>(null)
  const renderCueRef = useRef<'idle' | 'rendering'>('idle')
  const [orientationMeta, setOrientationMeta] = useState<any | null>(null)
  const orientationMetaKeyRef = useRef<string | null>(null)
  const [sliceMeta, setSliceMeta] = useState<any | null>(null)
  const sliceMetaKeyRef = useRef<string | null>(null)
  const userSizedRef = useRef<boolean>(false)
  const pendingTransformTargetRef = useRef<number | null>(null)
  const transformInFlightRef = useRef<boolean>(false)
  const transformPromiseRef = useRef<Promise<boolean> | null>(null)
  const pendingExportRequestedAtRef = useRef<number | null>(null)
  const pendingExportTargetRef = useRef<number | null>(null)
  const activeExportJobIdRef = useRef<string | null>(null)
  const lastExportJobStatusRef = useRef<string | null>(null)
  // Timestamp marking this page load; used to ignore stale jobs on reload
  const reloadAtRef = useRef<number>(Date.now())
  const expectedSizedAssetIdRef = useRef<string | null>(null)
  // Hard latch: once user clicks "Prepare new size STL", remain pending until the
  // correct sized STL is actually attached to the scene or the job fails.
  const [sizingLatch, setSizingLatch] = useState<boolean>(false)
  const sizingLatchRef = useRef<boolean>(false)
  const setSizingLocked = useCallback((value: boolean) => {
    sizingLatchRef.current = value
    setSizingLatch(value)
  }, [])
  const [activeExportJobStatus, setActiveExportJobStatus] = useState<string | null>(null)
  const [sizeStatus, setSizeStatusState] = useState<SizeStatus>('clean')
  const sizeStatusRef = useRef<SizeStatus>('clean')
  const [readyLongest, setReadyLongest] = useState<number | null>(null)
  const [pendingLongest, setPendingLongest] = useState<number | null>(null)
  const [pendingNeedsStl, setPendingNeedsStl] = useState<boolean>(false)
  const setSizeStatus = useCallback((next: SizeStatus | ((prev: SizeStatus) => SizeStatus)) => {
    setSizeStatusState((prev) => {
      const value = typeof next === 'function' ? (next as (prior: SizeStatus) => SizeStatus)(prev) : next
      sizeStatusRef.current = value
      return value
    })
  }, [])
  const storedSizeRef = useRef<number | null>(null)
  const lastRevisionRef = useRef<number | undefined>(orderRevision)
  const expectsMeshRef = useRef<boolean>(false)
  const setMeshExpectation = useCallback((value: boolean, options: { persist?: boolean } = {}) => {
    setExpectsMeshState(value)
    expectsMeshRef.current = value
    if (!orderId) {
      return
    }
    if (options.persist === false) return
    if (typeof window === 'undefined') return
    const key = `${VIEWER_EXPECT_KEY_PREFIX}${orderId}`
    try {
      if (value) {
        window.sessionStorage.setItem(key, '1')
      } else {
        window.sessionStorage.removeItem(key)
      }
    } catch {}
  }, [orderId])
  const notifyAtom = useCallback((text?: string | null) => {
    if (!orderId) return
    if (!text || !text.trim()) return
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
    try {
      const detail = { orderId, text: text.trim() }
      const evt = new CustomEvent('fabricator:atom-log', { detail })
      window.dispatchEvent(evt)
    } catch (err) {
      console.warn('[Stage] notifyAtom failed', err)
    }
  }, [orderId])

  useEffect(() => {
    renderCueRef.current = 'idle'
  }, [orderId])

  // Announce progress to the chat only when this order is explicitly
  // expected to produce a mesh (i.e., user initiated a job).
  useEffect(() => {
    if (!orderId) return
    const prev = renderCueRef.current
    if (awaitingTransformRef.current) return
    const expecting = expectsMeshRef.current
    if (waitingForMesh && !hasModel && expecting) {
      if (prev !== 'rendering') {
        renderCueRef.current = 'rendering'
        notifyAtom('Starting the render now — Atom is stabilizing your mesh.')
      }
      return
    }
    if (!waitingForMesh && hasModel && prev === 'rendering' && expecting) {
      renderCueRef.current = 'idle'
      notifyAtom('Mesh stabilized — the viewer is up to date.')
      return
    }
    if (!waitingForMesh && prev !== 'idle') {
      renderCueRef.current = 'idle'
    }
  }, [waitingForMesh, hasModel, orderId, notifyAtom])

  useEffect(() => {
    if (!orderId) {
      setMeshExpectation(false, { persist: false })
      return
    }
    if (typeof window === 'undefined') return
    const key = `${VIEWER_EXPECT_KEY_PREFIX}${orderId}`
    let stored = false
    try {
      stored = window.sessionStorage.getItem(key) === '1'
    } catch {}
    setMeshExpectation(stored, { persist: false })
  }, [orderId, setMeshExpectation])

  // Do not auto-mark expectation merely because the server reports a
  // generating state. Expectation should come from explicit user action
  // (job start) or successful adoption of geometry.
  useEffect(() => {
    /* intentionally no-op */
  }, [waitingForMesh])
  const applyTargetScaleRef = useRef<(() => void) | null>(null)
  const applyExactTargetScaleRef = useRef<((targetMm: number) => void) | null>(null)
  const applyInitialDisplayLongestRef = useRef<((baseLongest: number | null) => void) | null>(null)
  const sizeLimitMax = Math.max(20, Math.floor(Math.min(BUILD_VOLUME_X_MM, BUILD_VOLUME_Y_MM, BUILD_VOLUME_Z_MM)))
  const formatMM = useCallback((value: any) => {
    const num = Number(value)
    if (!Number.isFinite(num)) return '—'
    return num.toFixed(1)
  }, [])
  const renderMinutes = useCallback((meta: any) => {
    const raw = meta?.minutes ?? meta?.estimated_minutes
    const num = Number(raw)
    if (!Number.isFinite(num)) return 'time n/a'
    return `${num.toFixed(1)} min`
  }, [])
  const renderGrams = useCallback((meta: any) => {
    const raw = meta?.grams ?? meta?.estimated_grams
    const num = Number(raw)
    if (!Number.isFinite(num)) return 'mass n/a'
    return `${num.toFixed(1)} g`
  }, [])

  const seatOnBed = useCallback((obj: THREE.Object3D | null) => {
    if (!obj) return
    const box = new THREE.Box3().setFromObject(obj)
    const center = box.getCenter(new THREE.Vector3())
    obj.position.x -= center.x
    obj.position.z -= center.z
    obj.position.y -= box.min.y
    obj.updateMatrixWorld(true)
  }, [])

  const clampToVolumeRef = useRef<(obj: THREE.Object3D) => void>(() => {})
  const fitCameraToObjectRef = useRef<((obj: THREE.Object3D, options?: CameraFocusOptions) => void) | null>(null)

  const applyTargetScale = useCallback(() => {
    const obj = objectRef.current
    if (!obj) return
    const baseS = baseScaleRef.current
    const baseMax = baseMaxDimRef.current
    if (!baseS || !baseMax || baseMax <= 0) return
    const ratio = Math.max(0.01, displayLongest) / baseMax
    obj.scale.set(baseS.x * ratio, baseS.y * ratio, baseS.z * ratio)
    obj.updateMatrixWorld(true)
    seatOnBed(obj)
    try {
      // Avoid immediately shrinking an already sized STL; displayLongest is
      // already clamped to the build volume via clampLongest.
      const k = (currentAssetInfoRef.current?.kind || '') as string
      if (k !== 'repaired_sized_stl') {
        clampToVolumeRef.current?.(obj)
      }
    } catch {}
    obj.updateMatrixWorld(true)
    // Enforce exact target if numerical drift remains (unit mismatch or stale baselines)
    try {
      const box2 = new THREE.Box3().setFromObject(obj)
      const s2 = box2.getSize(new THREE.Vector3())
      const currentLongest = Math.max(s2.x, s2.y, s2.z)
      const target = Math.max(1, Number(displayLongest) || 1)
      if (Number.isFinite(currentLongest) && currentLongest > 1e-6) {
        const err = Math.abs(currentLongest - target)
        if (err > 0.75) {
          const fix = target / currentLongest
          obj.scale.multiplyScalar(fix)
          obj.updateMatrixWorld(true)
          seatOnBed(obj)
        }
      }
    } catch {}
    if (pendingInitialPlacementRef.current) {
      pendingInitialPlacementRef.current = false
      try { fitCameraToObjectRef.current?.(obj, { mode: 'fit' }) } catch {}
      return
    }
    try { fitCameraToObjectRef.current?.(obj, { mode: 'maintain' }) } catch {}
  }, [displayLongest, seatOnBed])

  applyTargetScaleRef.current = applyTargetScale

  const clampLongest = useCallback((value: number) => {
    const min = 20
    if (!Number.isFinite(value)) return min
    return Math.min(sizeLimitMax, Math.max(min, value))
  }, [sizeLimitMax])

  const persistSliderValue = useCallback((value: number | null) => {
    if (typeof window === 'undefined' || !orderId) return
    const key = `${SIZE_STORAGE_PREFIX}${orderId}`
    try {
      if (value == null) {
        window.localStorage.removeItem(key)
      } else {
        const payload = JSON.stringify({ value, savedAt: Date.now() })
        window.localStorage.setItem(key, payload)
      }
    } catch {}
  }, [orderId])

  const applyInitialDisplayLongest = useCallback((baseLongest: number | null) => {
    if (!baseLongest || baseLongest <= 0) return
    if (storedSizeRef.current != null) {
      const stored = clampLongest(storedSizeRef.current)
      storedSizeRef.current = null
      userSizedRef.current = true
      if (Math.abs(displayLongest - stored) > 0.5) {
        setDisplayLongest(stored)
      }
      return
    }
    const workerValue = workerLongestRef.current && workerLongestRef.current > 0 ? clampLongest(workerLongestRef.current) : null
    const candidate = workerValue ?? clampLongest(Math.round(baseLongest))
    if (sizingActiveRef.current) return
    userSizedRef.current = false
    if (Math.abs(displayLongest - candidate) > 0.5) {
      setDisplayLongest(candidate)
    }
  }, [clampLongest, displayLongest])

  applyInitialDisplayLongestRef.current = applyInitialDisplayLongest

  // Precisely scale the live object so its longest side equals targetMm.
  const applyExactTargetScale = useCallback((targetMm: number) => {
    const obj = objectRef.current
    if (!obj) return
    const target = clampLongest(Math.max(1, Number(targetMm) || 0))
    const box = new THREE.Box3().setFromObject(obj)
    const size = box.getSize(new THREE.Vector3())
    const currentLongest = Math.max(size.x, size.y, size.z)
    if (!Number.isFinite(currentLongest) || currentLongest <= 0) return
    const ratio = target / currentLongest
    obj.scale.multiplyScalar(ratio)
    obj.updateMatrixWorld(true)
    seatOnBed(obj)
    // Re-clamp only if overshooting the cage (should not happen due to clampLongest)
    try {
      const box2 = new THREE.Box3().setFromObject(obj)
      const s2 = box2.getSize(new THREE.Vector3())
      const limitX = Math.max(1, BUILD_VOLUME_X_MM - 2)
      const limitY = Math.max(1, BUILD_VOLUME_Y_MM - 2)
      const limitZ = Math.max(1, BUILD_VOLUME_Z_MM - 2)
      if (s2.x > limitX + 1e-4 || s2.y > limitY + 1e-4 || s2.z > limitZ + 1e-4) {
        const sx = limitX / Math.max(1e-6, s2.x)
        const sy = limitY / Math.max(1e-6, s2.y)
        const sz = limitZ / Math.max(1e-6, s2.z)
        const shrink = Math.min(1, sx, sy, sz)
        if (shrink < 1) {
          obj.scale.multiplyScalar(shrink)
          obj.updateMatrixWorld(true)
          seatOnBed(obj)
        }
      }
    } catch {}
    // Update baselines so future slider changes are relative to this exact size
    try {
      const box3 = new THREE.Box3().setFromObject(obj)
      const s3 = box3.getSize(new THREE.Vector3())
      baseScaleRef.current = obj.scale.clone()
      baseMaxDimRef.current = Math.max(s3.x, s3.y, s3.z)
    } catch {}
    setReadyLongest(target)
    setPendingLongest(null)
    // Align UI slider to the exact target
    if (Math.abs(displayLongest - target) > 0.25) {
      setDisplayLongest(target)
    }
    // Camera refit to make it visually fill the cage
    try { fitCameraToObjectRef.current?.(obj, { mode: 'fit' }) } catch {}
  }, [clampLongest, displayLongest, seatOnBed])

  applyExactTargetScaleRef.current = applyExactTargetScale

  // Helper: after adopting/refreshing geometry, apply correct scaling.
  // If the current asset is a sized STL with meta.target_max_dim_mm, apply exact scaling;
  // otherwise initialize slider and apply relative target scale.
  const applyAdoptionScaleForCurrentAsset = useCallback((baseMaxDim: number | null) => {
    const kNow = (currentAssetInfoRef.current?.kind || '') as string
    const meta = currentAssetInfoRef.current?.meta || null
    const t = meta && typeof meta.target_max_dim_mm === 'number' ? Number(meta.target_max_dim_mm) : null
    const isViewerGlb = Boolean(meta && (meta.viewer === true || meta.viewer_glb === true))
    if ((kNow === 'repaired_sized_stl' || isViewerGlb) && t && t > 0) {
      applyExactTargetScaleRef.current?.(t)
    } else {
      applyInitialDisplayLongestRef.current?.(baseMaxDim)
      applyTargetScaleRef.current?.()
    }
    try {
      if (typeof performance !== 'undefined') {
        performance.mark('mesh_paint_end')
        try { performance.measure('time_to_mesh_paint', 'mesh_paint_start', 'mesh_paint_end') } catch {}
        const entries = performance.getEntriesByName('time_to_mesh_paint')
        const last = entries[entries.length - 1]
        if (last && (process.env.NODE_ENV !== 'production')) {
          console.debug('[Perf] time_to_mesh_paint', Math.round(last.duration), 'ms')
        }
      }
    } catch {}
  }, [])

  const clearToolpathGroup = useCallback(() => {
    if (!sceneRef.current) return
    const existing = toolpathGroupRef.current
    if (!existing) return
    sceneRef.current.remove(existing)
    existing.traverse((child: any) => {
      if (child?.geometry) {
        try { child.geometry.dispose() } catch {}
      }
    })
    toolpathGroupRef.current = null
  }, [])

  useEffect(() => {
    toolpathAssetRef.current = toolpathAsset
  }, [toolpathAsset])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && awaitingTransformTimerRef.current != null) {
        window.clearTimeout(awaitingTransformTimerRef.current)
      }
      awaitingTransformTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    modelExtRef.current = modelExt
  }, [modelExt])

  useEffect(() => {
    modelUrlRef.current = modelUrl
  }, [modelUrl])

  // Listen for explicit job-start signals from the console to mark
  // this order as expecting a mesh. This avoids phantom announcements
  // on a brand-new project before any user action.
  useEffect(() => {
    if (!orderId) return
    const onJobStart = (event: Event) => {
      try {
        const detail = (event as CustomEvent<{ orderId?: string }>).detail
        if (detail?.orderId && detail.orderId === orderId) {
          setMeshExpectation(true)
        }
      } catch {}
    }
    window.addEventListener('fabricator:job-start', onJobStart as EventListener)
    return () => {
      window.removeEventListener('fabricator:job-start', onJobStart as EventListener)
    }
  }, [orderId, setMeshExpectation])

  // Perf: mark start when a new model URL is set
  useEffect(() => {
    try { if (typeof performance !== 'undefined' && modelUrl) performance.mark('mesh_paint_start') } catch {}
  }, [modelUrl])

  // Preview overlay: track lightweight preview image (from snapshot) to show while STL is loading
  useEffect(() => {
    try {
      const p = (localPreview as any)?.previewUrl as string | undefined
      setPreviewOverlayUrl(p ? String(p) : null)
    } catch {
      setPreviewOverlayUrl(null)
    }
  }, [localPreview])

  useEffect(() => {
    if (!hasModel) {
      setPendingLongest(null)
      setReadyLongest(null)
      setSizeStatus('clean')
    }
  }, [hasModel, setPendingLongest, setReadyLongest, setSizeStatus])

  const ensureTokenOrNotice = useCallback(async (): Promise<string | null> => {
    const token = await getAccessToken()
    if (!token) {
      setNotice('Sign in to prepare and download print-ready files.')
    }
    return token
  }, [])

  const authFetch = useCallback(
    async (input: RequestInfo | URL, init: RequestInit = {}, opts: { forceRefresh?: boolean } = {}) => {
      const res = await authedFetch(input, init, opts)
      return res
    },
    []
  )

  const captureViewerPreview = useCallback((): string | null => {
    const renderer = rendererRef.current
    if (!renderer) return null
    try {
      return renderer.domElement.toDataURL('image/png', 0.92)
    } catch (error) {
      console.warn('[Stage] preview capture failed', error)
      return null
    }
  }, [])

  useEffect(() => {
    if (!orientationMeta?.bbox_mm) return
    if (userSizedRef.current || sizingActiveRef.current) return
    if (sizeStatus === 'processing') return
    if (awaitingTransformRef.current) return
    const longest = Math.max(
      Number(orientationMeta.bbox_mm.x || 0),
      Number(orientationMeta.bbox_mm.y || 0),
      Number(orientationMeta.bbox_mm.z || 0)
    )
    if (longest > 0) {
      if (!baseMaxDimRef.current || Math.abs(baseMaxDimRef.current - longest) > 0.5) {
        baseMaxDimRef.current = longest
      }
      const clamped = clampLongest(Math.round(longest))
      if (!workerLongestRef.current && Math.abs(displayLongest - clamped) > 0.5) {
        setDisplayLongest(clamped)
      }
  }
  }, [orientationMeta, clampLongest, displayLongest, sizeStatus])

  const requestCancel = useCallback(
    async (source: 'esc' | 'refresh') => {
      if (!orderId) return
      const currentStatus = orderStatusRef.current
      if (!currentStatus || !CANCELLABLE_ORDER_STATUSES.has(currentStatus)) return
      let token = accessTokenRef.current
      if (!token && source !== 'refresh') {
        try {
          token = await getAccessToken()
          if (token) accessTokenRef.current = token
        } catch {
          token = null
        }
      }
      if (!token) return
      if (source !== 'refresh') {
        if (cancelRequestRef.current) return
        cancelRequestRef.current = true
      }
      try {
        await fetch(`/api/orders/${orderId}/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: source }),
          keepalive: source === 'refresh',
        })
      } catch (err) {
        if (source !== 'refresh') {
          console.warn('[Stage] cancel request failed', err)
        }
      } finally {
        if (source !== 'refresh') {
          cancelRequestRef.current = false
        }
      }
    },
    [orderId]
  )

  useEffect(() => {
    getAccessToken()
      .then((token) => {
        if (token) accessTokenRef.current = token
      })
      .catch(() => null)
    return onAccessTokenChange((token) => {
      accessTokenRef.current = token
    })
  }, [])

  useEffect(() => {
    orderStatusRef.current = orderStatus
  }, [orderStatus])

  useEffect(() => {
    const failureMessage = orderStatus ? FAILURE_NOTICE_MAP[orderStatus] : undefined
    if (failureMessage) {
      if (notice !== failureMessage) setNotice(failureMessage)
    } else if (notice && FAILURE_NOTICE_VALUES.has(notice)) {
      setNotice(null)
    }
  }, [orderStatus, notice])

  useEffect(() => {
    if (!orderId) return
    if (!orderStatus || !CANCELLABLE_ORDER_STATUSES.has(orderStatus)) return
    if (accessTokenRef.current) return
    getAccessToken()
      .then((token) => {
        if (token) accessTokenRef.current = token
      })
      .catch(() => null)
  }, [orderId, orderStatus])

  useEffect(() => {
    if (!orderId) return
    if (!orderStatus || !CANCELLABLE_ORDER_STATUSES.has(orderStatus)) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      void requestCancel('esc')
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
    }
  }, [orderId, orderStatus, requestCancel])

  useEffect(() => {
    if (!orderId) return
    if (!orderStatus || !CANCELLABLE_ORDER_STATUSES.has(orderStatus)) return
    const handleUnload = () => {
      void requestCancel('refresh')
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => {
      window.removeEventListener('beforeunload', handleUnload)
    }
  }, [orderId, orderStatus, requestCancel])

  useEffect(() => {
    transformInFlightRef.current = false
    transformPromiseRef.current = null
    pendingTransformTargetRef.current = null
    setSavingSize(false)
    if (typeof window !== 'undefined' && orderId) {
      const key = `${SIZE_STORAGE_PREFIX}${orderId}`
      const raw = window.localStorage.getItem(key)
      if (raw != null) {
        try {
          const parsed = JSON.parse(raw)
          const value = Number(parsed?.value)
          const savedAt = Number(parsed?.savedAt)
          const fresh = Number.isFinite(savedAt) ? Date.now() - savedAt <= SIZE_STORAGE_TTL_MS : true
          if (fresh && Number.isFinite(value)) {
            storedSizeRef.current = value
          } else {
            storedSizeRef.current = null
            window.localStorage.removeItem(key)
          }
        } catch {
          try { window.localStorage.removeItem(key) } catch {}
          storedSizeRef.current = null
        }
      } else {
        storedSizeRef.current = null
      }
    } else {
      storedSizeRef.current = null
    }
  }, [orderId])

  const stopSizingInteraction = useCallback(() => {
    if (sizingActiveRef.current) {
      sizingActiveRef.current = false
      setSizingActive(false)
    }
  }, [])

  const clearAwaitingTransform = useCallback(() => {
    awaitingTransformRef.current = false
    setAwaitingTransform(false)
    if (typeof window !== 'undefined' && awaitingTransformTimerRef.current != null) {
      window.clearTimeout(awaitingTransformTimerRef.current)
    }
    awaitingTransformTimerRef.current = null
  }, [])

  const clearPendingExport = useCallback(() => {
    pendingExportRequestedAtRef.current = null
    pendingExportTargetRef.current = null
    activeExportJobIdRef.current = null
  }, [])

  // Hint the user to retry if a queued export job appears stuck (worker did not claim
  // or complete within a reasonable time). This stays UI-only and does not change
  // server state unless the user clicks Retry.
  const [exportRetryHint, setExportRetryHint] = useState<boolean>(false)
  const exportRetryInFlightRef = useRef<boolean>(false)

  const markPendingExport = useCallback((target: number | null) => {
    pendingExportRequestedAtRef.current = Date.now()
    if (Number.isFinite(target) && target != null) {
      pendingExportTargetRef.current = Number(target)
    } else {
      pendingExportTargetRef.current = null
    }
    setPendingSize(true)
    recomputePrepareAbility()
  }, [recomputePrepareAbility, setPendingSize])

  const markAwaitingTransform = useCallback(() => {
    awaitingTransformRef.current = true
    setAwaitingTransform(true)
    if (typeof window !== 'undefined') {
      if (awaitingTransformTimerRef.current != null) {
        window.clearTimeout(awaitingTransformTimerRef.current)
      }
      awaitingTransformTimerRef.current = window.setTimeout(() => {
        awaitingTransformRef.current = false
        setAwaitingTransform(false)
        awaitingTransformTimerRef.current = null
        setSizeStatus((prev) => (prev === 'processing' ? 'dirty' : prev))
      }, 45000)
    }
  }, [setSizeStatus])

  const resetViewerState = useCallback(() => {
    clearAwaitingTransform()
    clearPendingExport()
    clearSceneRef.current?.()
    currentAssetIdRef.current = null
    currentAssetKeyRef.current = null
    currentAssetCreatedAtRef.current = null
    currentAssetInfoRef.current = null
    currentKindRef.current = null
    workerLongestRef.current = null
    committedLongestRef.current = null
    pendingInitialPlacementRef.current = false
    userSizedRef.current = false
    setHasModel(false)
    setModelUrl(null)
    setModelExt(null)
    modelUrlRef.current = null
    baseScaleRef.current = null
    baseMaxDimRef.current = null
    setWaitingForMesh(false)
    setPrintReadyUrl(null)
    clearToolpathGroup()
    setToolpathLayers([])
    setToolpathMode(false)
    setToolpathAsset(null)
    toolpathBBoxRef.current = null
    currentToolpathAssetIdRef.current = null
    setToolpathError(null)
    setToolpathLoading(false)
    setToolLayerIndex(0)
    setNotice(null)
    setReadyLongest(null)
    setPendingLongest(null)
    setSizeStatus('clean')
    setSizeOpen(false)
    pendingSizeRef.current = false
    basePrepareRef.current = false
    setSizePendingExport(false)
    setPendingNeedsStl(false)
    recomputePrepareAbility()
  }, [
    clearAwaitingTransform,
    clearPendingExport,
    clearToolpathGroup,
    setHasModel,
    setModelExt,
    setModelUrl,
    setNotice,
    setPendingLongest,
    setPrintReadyUrl,
    setReadyLongest,
    setSizeStatus,
    setToolLayerIndex,
    setToolpathAsset,
    setToolpathError,
    setToolpathLayers,
    setToolpathLoading,
    setToolpathMode,
    setWaitingForMesh,
    setSizeOpen,
    setSizePendingExport,
    setPendingNeedsStl,
    recomputePrepareAbility,
  ])

  useEffect(() => {
    resetViewerState()
  }, [orderId, resetViewerState])

  useEffect(() => {
    if (orderRevision == null) return
    if (lastRevisionRef.current === orderRevision) return
    lastRevisionRef.current = orderRevision
    resetViewerState()
    storedSizeRef.current = null
    committedLongestRef.current = null
    workerLongestRef.current = null
    setDisplayLongest(DEFAULT_LONGEST)
    persistSliderValue(null)
  }, [orderRevision, resetViewerState, persistSliderValue])

  const applyWorkerLongest = useCallback(
    (value: any, opts: { fallback?: number | null } = {}) => {
      const toNumber = (input: any): number | null => {
        const num = Number(input)
        return Number.isFinite(num) && num > 0 ? num : null
      }
      const fallbackValue = toNumber(opts.fallback)
      let resolved = toNumber(value)
      if (resolved == null) {
        resolved = fallbackValue
      }
      if (resolved == null) {
        resolved = toNumber(displayLongest)
      }
      if (resolved == null) {
        const fallbackClamped = clampLongest(displayLongest)
        workerLongestRef.current = fallbackClamped
        committedLongestRef.current = fallbackClamped
        pendingTransformTargetRef.current = null
        persistSliderValue(fallbackClamped)
        setReadyLongest(fallbackClamped)
        setPendingLongest(null)
        setSizeStatus('clean')
        return
      }
      const clamped = clampLongest(resolved)
      workerLongestRef.current = clamped
      committedLongestRef.current = clamped
      pendingTransformTargetRef.current = null
      if (!sizingActiveRef.current && Math.abs(displayLongest - clamped) > 0.5) {
        setDisplayLongest(clamped)
      }
      persistSliderValue(clamped)
      setReadyLongest(clamped)
      setPendingLongest(null)
      setSizeStatus('clean')
    },
    [clampLongest, displayLongest, persistSliderValue, setReadyLongest, setPendingLongest, setSizeStatus]
  )

  useEffect(() => {
    recomputePrepareAbility()
  }, [sizeStatus, recomputePrepareAbility])

  const beginSizingInteraction = useCallback(() => {
    if (!sizingActiveRef.current) {
      sizingActiveRef.current = true
      setSizingActive(true)
    }
  }, [])

  const sendTransform = useCallback((target: number): Promise<boolean> => {
    if (!orderId || !Number.isFinite(target)) {
      return Promise.resolve(false)
    }
    const run = async (): Promise<boolean> => {
      transformInFlightRef.current = true
      setSavingSize(true)
      console.debug('[Stage] transform → POST', { orderId, target })
      let success = false
      try {
        const res = await authFetch(`/api/orders/${orderId}/transform`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_max_dim_mm: target })
        })
        if (res.ok) {
          // Do NOT zero drift on transform commit; only update baseline on asset adoption
          pendingTransformTargetRef.current = null
          markAwaitingTransform()
          success = true
          console.debug('[Stage] transform ← ok', { orderId, target })
        } else {
          console.warn('[Stage] transform ← failed', { status: res.status, target })
        }
      } catch (err: any) {
        if (!String(err?.message || '').includes('not_authenticated')) {
          console.warn('[Stage] transform update failed', err)
        }
      } finally {
        transformInFlightRef.current = false
        setSavingSize(false)
      }
      return success
    }
    const prev = transformPromiseRef.current || Promise.resolve(true)
    const next = prev.then(() => run())
    transformPromiseRef.current = next.catch((err) => {
      console.warn('[Stage] transform chain failure', err)
      return false
    })
    return next
  }, [authFetch, markAwaitingTransform, orderId])

  const commitSizeIfNeeded = useCallback(async (override?: number): Promise<boolean> => {
    if (!orderId) return false
    const target = clampLongest(override ?? displayLongest)
    const baseline = readyLongest != null ? readyLongest : committedLongestRef.current
    if (baseline != null && Math.abs(baseline - target) < 0.5) {
      pendingTransformTargetRef.current = null
      setPendingLongest(null)
      setSizeStatus('clean')
      setPendingSize(false)
      recomputePrepareAbility()
      return true
    }
    pendingTransformTargetRef.current = target
    setPendingLongest(target)
    persistSliderValue(target)
    setPendingSize(true)
    setSizeStatus('processing')
    const ok = await sendTransform(target)
    if (!ok) {
      setSizeStatus('dirty')
    }
    return ok
  }, [orderId, clampLongest, displayLongest, readyLongest, sendTransform, persistSliderValue, setPendingLongest, setSizeStatus, setPendingSize, recomputePrepareAbility])

  const handleDisplayChange = useCallback((value: number, _opts: { immediate?: boolean } = {}) => {
    const clamped = clampLongest(value)
    userSizedRef.current = true
    setDisplayLongest(clamped)
    pendingTransformTargetRef.current = clamped
    persistSliderValue(clamped)
    beginSizingInteraction()
    const baseline = readyLongest != null ? readyLongest : committedLongestRef.current
    const differs = baseline == null || Math.abs(baseline - clamped) >= 0.5
    setPendingLongest(differs ? clamped : null)
    setPendingSize(differs)
    setSizeStatus((prev) => {
      if (prev === 'processing') return prev
      return differs ? 'dirty' : 'clean'
    })
    if (!differs) {
      recomputePrepareAbility()
    }
  }, [beginSizingInteraction, clampLongest, persistSliderValue, readyLongest, setPendingLongest, setSizeStatus, recomputePrepareAbility, setPendingSize])

  const handleSliderPointerUp = useCallback(() => {
    stopSizingInteraction()
  }, [stopSizingInteraction])

  const handleRevertSize = useCallback(() => {
    const baseline = readyLongest != null ? readyLongest : committedLongestRef.current
    if (baseline == null) return
    const clamped = clampLongest(baseline)
    stopSizingInteraction()
    userSizedRef.current = false
    setDisplayLongest(clamped)
    pendingTransformTargetRef.current = null
    setPendingLongest(null)
    persistSliderValue(clamped)
    committedLongestRef.current = clamped
    workerLongestRef.current = clamped
    setSizeStatus('clean')
    setPendingSize(false)
    recomputePrepareAbility()
  }, [clampLongest, readyLongest, persistSliderValue, setPendingLongest, setSizeStatus, stopSizingInteraction, recomputePrepareAbility, setPendingSize])

  const considerCandidate = useCallback((candidate: StageCandidate | null): boolean => {
    if (!candidate || !candidate.url) return false

    const normalizeExt = (): string | null => {
      if (candidate.ext) {
        return String(candidate.ext).toLowerCase()
      }
      const rawUrl = candidate.url || ''
      try {
        const parsed = new URL(rawUrl)
        const pathname = parsed.pathname || ''
        const idx = pathname.lastIndexOf('.')
        return idx >= 0 ? pathname.slice(idx + 1).toLowerCase() : null
      } catch {
        const path = (rawUrl.split('?')[0] || '').toLowerCase()
        const idx = path.lastIndexOf('.')
        return idx >= 0 ? path.slice(idx + 1) : null
      }
    }

    const resolveKind = (ext: string | null): AllowedAssetKind | null => {
      const raw = candidate.assetKind
      if (raw && ALLOWED_ASSET_KINDS.has(raw as AllowedAssetKind)) {
        return raw as AllowedAssetKind
      }
      switch (ext) {
        case 'stl':
          return 'repaired_stl'
        case 'obj':
          return 'upload_obj'
        case 'glb':
          return 'upload_glb'
        case 'gltf':
          return 'upload_gltf'
        default:
          return null
      }
    }

    const toTimestamp = (value: StageCandidate['createdAt']): number | null => {
      if (value == null) return null
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null
      }
      const ms = Date.parse(String(value))
      return Number.isFinite(ms) ? ms : null
    }

    const ext = normalizeExt()
    const resolvedKind = resolveKind(ext)
    if (!resolvedKind) {
      console.debug('[Stage] candidate skipped: unsupported kind', {
        source: candidate.source || 'unknown',
        assetId: candidate.assetId || null,
        assetKind: candidate.assetKind || null,
      })
      return false
    }

    const candidatePriority = KIND_PRIORITY[resolvedKind]
    const currentKind = currentKindRef.current
    const currentPriority = currentKind ? KIND_PRIORITY[currentKind] : -1
    const candidateId = candidate.assetId || null
    const candidateKey = candidateId || candidate.url
    const currentId = currentAssetIdRef.current
    const currentKey = currentAssetKeyRef.current
    const urlChanged = candidate.url !== modelUrlRef.current
    const candidateTimestamp = toTimestamp(candidate.createdAt)
    const currentTimestamp = currentAssetCreatedAtRef.current
    const assetChanged = candidateKey !== currentKey
    const meshMounted = Boolean(objectRef.current)
    const candidateMeta = candidate.meta ?? null
    const candidateMetaTargetRaw = candidateMeta?.target_max_dim_mm ?? candidateMeta?.target_max_dim ?? candidateMeta?.target
    const metaTargetNumber = Number(candidateMetaTargetRaw)
    const candidateMetaTarget = Number.isFinite(metaTargetNumber) ? metaTargetNumber : null
    const pendingExportRequestedAt = pendingExportRequestedAtRef.current
    const pendingExportTarget = pendingExportTargetRef.current
    const awaitingFreshSized = resolvedKind === 'repaired_sized_stl' && sizeStatusRef.current === 'processing' && (awaitingTransformRef.current || pendingExportRequestedAt != null)

    console.debug('[Stage] consider', {
      source: candidate.source || 'unknown',
      kind: resolvedKind,
      currentKind,
      candidateId,
      candidateKey,
      currentKey,
      urlChanged,
      meshMounted,
      priority: candidatePriority,
      currentPriority,
    })

    // Always enforce target/time gating for sized STLs to avoid accepting
    // older completions when a new request is in flight.
    if (resolvedKind === 'repaired_sized_stl') {
      // Always allow the exact asset we expect from the latest job
      if (expectedSizedAssetIdRef.current && candidateId && candidateId === expectedSizedAssetIdRef.current) {
        console.debug('[Stage] candidate accepted: matches expected sized asset', { assetId: candidateId })
      } else {
        const TOL_MM = 0.15
        const mustMatchTarget = pendingExportTarget != null
        const timeIsOld = pendingExportRequestedAt != null && candidateTimestamp != null && candidateTimestamp < pendingExportRequestedAt - 5
        const targetMismatch = mustMatchTarget && (candidateMetaTarget == null || Math.abs(candidateMetaTarget - (pendingExportTarget as number)) > TOL_MM)
        if (timeIsOld || targetMismatch) {
        console.debug('[Stage] candidate skipped: sized export does not match active request', {
          source: candidate.source || 'unknown',
          assetId: candidateId,
          candidateTimestamp,
          pendingExportRequestedAt,
          candidateMetaTarget,
          pendingExportTarget,
        })
          return false
        }
        // Legacy path: if no explicit pending target but user has drifted the slider,
        // require the sized asset to match the visible slider value.
        if (!mustMatchTarget && typeof displayLongest === 'number' && candidateMetaTarget != null) {
          if (Math.abs(candidateMetaTarget - displayLongest) > TOL_MM) {
            console.debug('[Stage] candidate skipped: sized export not for current slider', {
              assetId: candidateId,
              candidateMetaTarget,
              displayLongest,
            })
            return false
          }
        }
      }
    }

    const exportPending = pendingExportRequestedAtRef.current != null
    const awaitingSizedRefresh = exportPending || sizeStatusRef.current !== 'clean' || sizingLatchRef.current
    if (
      meshMounted &&
      currentKindRef.current === 'repaired_sized_stl' &&
      resolvedKind === 'repaired_sized_stl' &&
      candidate.source !== 'manual' &&
      !awaitingSizedRefresh
    ) {
      console.debug('[Stage] candidate skipped: sized refresh suppressed', {
        assetId: candidateId,
        source: candidate.source || 'unknown',
      })
      return false
    }

    if (!meshMounted) {
      console.debug('[Stage] candidate accepted (initial)', {
        source: candidate.source || 'unknown',
        kind: resolvedKind,
        assetId: candidateId,
      })
      currentKindRef.current = resolvedKind
      currentAssetIdRef.current = candidateKey
      currentAssetKeyRef.current = candidateKey
      if (candidateTimestamp != null) currentAssetCreatedAtRef.current = candidateTimestamp
      currentAssetInfoRef.current = { kind: resolvedKind, meta: candidate.meta ?? currentAssetInfoRef.current?.meta ?? null }
      modelUrlRef.current = candidate.url
      if (ext) setModelExt(ext)
      if (resolvedKind === 'repaired_sized_stl') {
        const fallbackTarget =
          pendingExportTargetRef.current ??
          pendingTransformTargetRef.current ??
          committedLongestRef.current ??
          displayLongest
        clearPendingExport()
        setPendingSize(false)
        setPendingNeedsStl(false)
        applyWorkerLongest(candidateMetaTarget ?? candidateMetaTargetRaw, { fallback: fallbackTarget })
        // Mark printable immediately on adoption
        setBasePrepare(true)
        try { if (candidate.url) setPrintReadyUrl(candidate.url) } catch {}
        setSizeStatus('clean')
        setSizingLocked(false)
        setExportRetryHint(false)
        expectedSizedAssetIdRef.current = null
      }
      setModelUrl(candidate.url)
      setMeshExpectation(true)
      recomputePrepareAbility()
      return true
    }

    if (!assetChanged && !urlChanged) {
      return false
    }

    if (!assetChanged) {
      const expectingSized = resolvedKind === 'repaired_sized_stl' && (awaitingSizedRefresh || exportPending)
      const metaChanged = candidateMetaTarget != null && (workerLongestRef.current == null || Math.abs(workerLongestRef.current - candidateMetaTarget) > 0.25)
      if (resolvedKind === 'repaired_sized_stl' && (expectingSized || metaChanged || urlChanged)) {
        console.debug('[Stage] candidate refresh accepted (same asset)', {
          source: candidate.source || 'unknown',
          kind: resolvedKind,
          assetId: candidateId,
          expectingSized,
          metaTarget: candidateMetaTarget,
        })
        currentAssetInfoRef.current = { kind: resolvedKind, meta: candidate.meta ?? currentAssetInfoRef.current?.meta ?? null }
        if (candidateTimestamp != null) currentAssetCreatedAtRef.current = candidateTimestamp
        modelUrlRef.current = candidate.url
        if (ext) setModelExt(ext)
        clearPendingExport()
        setPendingSize(false)
        setPendingNeedsStl(false)
        const fallbackTarget =
          pendingExportTargetRef.current ??
          pendingTransformTargetRef.current ??
          committedLongestRef.current ??
          displayLongest
        applyWorkerLongest(candidateMetaTarget ?? candidateMetaTargetRaw, { fallback: fallbackTarget })
        setBasePrepare(true)
        try { if (candidate.url) setPrintReadyUrl(candidate.url) } catch {}
        setModelUrl(candidate.url)
        setMeshExpectation(true)
        setNotice(null)
        recomputePrepareAbility()
        setSizeStatus('clean')
        setSizingLocked(false)
        setExportRetryHint(false)
        expectedSizedAssetIdRef.current = null
        return true
      }
      if (!urlChanged) {
        return false
      }
      console.debug('[Stage] candidate refresh (same asset, new url)', {
        source: candidate.source || 'unknown',
        kind: resolvedKind,
        assetId: candidateId,
      })
      currentAssetInfoRef.current = { kind: resolvedKind, meta: candidate.meta ?? currentAssetInfoRef.current?.meta ?? null }
      return false
    }

    if (candidatePriority < currentPriority) {
      console.debug('[Stage] candidate skipped: downgrade', {
        from: currentKind,
        to: resolvedKind,
        source: candidate.source || 'unknown',
        assetId: candidateId,
      })
      return false
    }
    if (candidatePriority === currentPriority) {
      const newer = candidateTimestamp != null && (currentTimestamp == null || candidateTimestamp >= currentTimestamp)
      if (!newer) {
        console.debug('[Stage] candidate skipped: stale', {
          source: candidate.source || 'unknown',
          assetId: candidateId,
        })
        return false
      }
    }

    currentKindRef.current = resolvedKind
    currentAssetIdRef.current = candidateKey
    currentAssetKeyRef.current = candidateKey
    if (candidateTimestamp != null) currentAssetCreatedAtRef.current = candidateTimestamp
    currentAssetInfoRef.current = { kind: resolvedKind, meta: candidate.meta ?? currentAssetInfoRef.current?.meta ?? null }
    // Ensure the canonical storage URL is set early so persistent cache reads and re-signs work on snapshot adoption
    try { currentAssetStorageUrlRef.current = (candidate.storageUrl as string) || null } catch { currentAssetStorageUrlRef.current = null }
    modelUrlRef.current = candidate.url
    if (ext) setModelExt(ext)
    console.debug('[Stage] candidate accepted', {
      source: candidate.source || 'unknown',
      kind: resolvedKind,
      assetId: candidateId,
    })
    if (resolvedKind === 'repaired_sized_stl') {
      const fallbackTarget =
        pendingExportTargetRef.current ??
        pendingTransformTargetRef.current ??
        committedLongestRef.current ??
        displayLongest
      clearPendingExport()
      setPendingSize(false)
      setPendingNeedsStl(false)
      applyWorkerLongest(candidateMetaTarget ?? candidateMetaTargetRaw, { fallback: fallbackTarget })
      setBasePrepare(true)
      try { if (candidate.url) setPrintReadyUrl(candidate.url) } catch {}
      setSizeStatus('clean')
      setSizingLocked(false)
      setExportRetryHint(false)
      expectedSizedAssetIdRef.current = null
    }
    setModelUrl(candidate.url)
    setMeshExpectation(true)
    recomputePrepareAbility()
    return true
  }, [applyWorkerLongest, setMeshExpectation, setModelExt, setModelUrl, clearPendingExport, displayLongest, setPendingSize, recomputePrepareAbility])

  useEffect(() => {
    if (!localPreview || !localPreview.url) return
    considerCandidate({
      url: localPreview.url,
      ext: localPreview.ext ?? null,
      kind: localPreview.kind,
      assetKind: localPreview.assetKind ?? null,
      assetId: localPreview.assetId ?? null,
      createdAt: localPreview.createdAt ?? null,
      source: localPreview.source || 'sse',
      storageUrl: localPreview.storageUrl ?? null,
      expiresAt: localPreview.expiresAt ?? null,
      meta: localPreview.meta,
    })
  }, [localPreview, considerCandidate])

  useEffect(() => {
    if (!orderId) return
    let cancelled = false
    const poll = async () => {
      try {
        console.debug('[Stage] polling order', orderId)
        const res = await authFetch(`/api/orders/${orderId}`, { cache: 'no-store' })
        if (!res.ok) {
          if (res.status === 401) {
            await ensureTokenOrNotice()
          } else {
            console.warn('[Stage] /api/orders response not ok:', res.status)
          }
          return
        }
        const data = await res.json()
        const assets = (data.assets || []) as any[]
        const status = typeof data.order?.status === 'string' ? data.order.status : null
        if (!cancelled) setOrderStatus(status)
        const exportJobs = Array.isArray(data.exportJobs) ? data.exportJobs : []

        // Separate slice jobs from export jobs
        const sliceJobs = exportJobs.filter((j: any) => j.job_type === 'slice')
        const exportSizeJobs = exportJobs.filter((j: any) => j.job_type === 'export' || !j.job_type)

        const normalizeStatus = (value: any): string => String(value || '').toLowerCase()
        const sortedJobs = exportSizeJobs
          .slice()
          .sort((a: any, b: any) => new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime())
        const trackedJobId = activeExportJobIdRef.current
        let trackedJob = trackedJobId ? sortedJobs.find((j: any) => j?.id === trackedJobId) : null
        // Only consider jobs created after we requested export or after reload, unless it's the tracked job id
        const since = Math.max(pendingExportRequestedAtRef.current ?? 0, reloadAtRef.current ?? 0)
        const pendingJob = sortedJobs.find((j: any) => {
          const js = normalizeStatus(j?.status)
          if (!['pending','processing'].includes(js)) return false
          if (trackedJobId && j?.id === trackedJobId) return true
          const ca = j?.created_at ? new Date(j.created_at).getTime() : 0
          return ca >= since
        })
        const latestJob = sortedJobs[0] || null
        const jobForState = trackedJob || pendingJob || latestJob || null
        const priorStatus = lastExportJobStatusRef.current
        if (jobForState) {
          const jobStatus = normalizeStatus(jobForState.status)
          if (!cancelled) setActiveExportJobStatus(jobStatus || null)
          const jobCreatedAt = jobForState.created_at ? new Date(jobForState.created_at).getTime() : Date.now()
          const jobTarget = typeof jobForState.target_max_dim_mm === 'number' ? jobForState.target_max_dim_mm : Number(jobForState.target_max_dim_mm) || null
        if (jobStatus === 'pending' || jobStatus === 'processing') {
          lastExportJobStatusRef.current = jobStatus
          pendingExportRequestedAtRef.current = jobCreatedAt
          if (jobTarget != null) {
            pendingExportTargetRef.current = jobTarget
            setPendingLongest(jobTarget)
          }
          if (jobForState.id && trackedJobId !== jobForState.id) {
            activeExportJobIdRef.current = jobForState.id
          }
          setPendingSize(true)
          if (sizeStatusRef.current !== 'processing') {
            setSizeStatus('processing')
          }
          setNotice((prev) => prev || 'Preparing print‑ready STL…')
          // If the worker did not claim/process quickly, surface a retry hint.
          try {
            const ageMs = Date.now() - jobCreatedAt
            const threshold = jobStatus === 'pending' ? 15000 : 90000 // 15s pending; 90s processing
            setExportRetryHint(ageMs > threshold)
          } catch {
            /* ignore */
          }
        } else if (jobStatus === 'succeeded') {
          lastExportJobStatusRef.current = 'succeeded'
          pendingExportRequestedAtRef.current = null
          pendingExportTargetRef.current = null
          activeExportJobIdRef.current = null
          expectedSizedAssetIdRef.current = jobForState.asset_id || null
          // Keep latch until the sized asset actually attaches
          // Do not flip to clean yet; adoption path will clear latch and set clean.
          setNotice((prev) => {
            if (!prev || prev.startsWith('Preparing')) return null
            return prev
          })
          // Nudge an immediate poll so we don't wait for the next 2s tick
          try { const maybe = pollRef.current?.(); if (maybe instanceof Promise) void maybe.catch(() => null) } catch {}
          // Success seen; no need to suggest retry now.
          setExportRetryHint(false)
        } else if (jobStatus === 'failed') {
          lastExportJobStatusRef.current = 'failed'
          pendingExportRequestedAtRef.current = null
          pendingExportTargetRef.current = null
          activeExportJobIdRef.current = null
          setPendingSize(false)
          clearPendingExport()
          setSizeStatus('dirty')
          setNotice(jobForState.error_message || 'Sized STL failed to prepare — adjust the mesh or retry.')
          setSizingLocked(false)
          setExportRetryHint(true)
        } else {
          if (priorStatus && priorStatus !== jobStatus) {
            lastExportJobStatusRef.current = jobStatus
          }
        }
      } else {
        lastExportJobStatusRef.current = null
        if (!cancelled) setActiveExportJobStatus(null)
        setExportRetryHint(false)
      }
        const pickLatest = (predicate: (a: any) => boolean) => {
          for (let i = assets.length - 1; i >= 0; i--) { if (predicate(assets[i])) return assets[i] }
          return null
        }
        const latestSized = pickLatest((a) => a.kind === 'repaired_sized_stl')
        const latestRepaired = pickLatest((a) => a.kind === 'repaired_stl')
        const latestRaw = pickLatest((a) => (a.kind || '').startsWith('raw_'))
        const latestUpload = pickLatest((a) => a.kind === 'upload_stl' || a.kind === 'upload_obj' || a.kind === 'upload_glb' || a.kind === 'upload_gltf')
        const latestProxy = pickLatest((a) => a.kind === 'proxy_stl')
        const latestToolpath = pickLatest((a) => a.kind === 'three_mf')
        const statusForGate = status || data.order?.status
        const exportPending = pendingExportRequestedAtRef.current != null || ['pending','processing'].includes((lastExportJobStatusRef.current || '').toLowerCase())
        const generatingStates = new Set(['generating','materializing','repairing','fabrication_requested','exporting'])
        const stabilizedAsset = latestSized || latestRepaired
        const asset = stabilizedAsset || (statusForGate && generatingStates.has(statusForGate) ? null : (latestUpload || latestProxy || latestRaw))
        const orientationSource = stabilizedAsset?.meta_json?.orientation || latestRepaired?.meta_json?.orientation || latestSized?.meta_json?.orientation || null
        const orientationKey = orientationSource ? JSON.stringify(orientationSource) : null
        if (orientationMetaKeyRef.current !== orientationKey) {
          orientationMetaKeyRef.current = orientationKey
          setOrientationMeta(orientationSource)
        }

        // Process slice jobs for print check status
        const latestSliceJob = sliceJobs.length > 0
          ? sliceJobs.reduce((latest: any, current: any) => {
              const latestTime = new Date(latest.created_at).getTime()
              const currentTime = new Date(current.created_at).getTime()
              return currentTime > latestTime ? current : latest
            })
          : null

        const sliceJobStatus = latestSliceJob ? normalizeStatus(latestSliceJob.status) : null
        const sliceJobQuote = latestSliceJob?.quote_json || null
        const sliceJobError = latestSliceJob?.error_message || null

        // Derive slice UI state
        const sliceRunning = sliceJobStatus === 'pending' || sliceJobStatus === 'processing'
        const sliceFailed = sliceJobStatus === 'failed'
        const sliceSucceeded = sliceJobStatus === 'succeeded'

        // Update slice metadata display from job
        if (sliceSucceeded && sliceJobQuote) {
          const sliceSource = {
            status: 'ok',  // Use 'ok' to match existing UI logic
            minutes: sliceJobQuote.minutes,
            grams: sliceJobQuote.grams,
            price_cents: (typeof sliceJobQuote.total_cents === 'number' ? sliceJobQuote.total_cents : sliceJobQuote.price_cents)
          }
          const sliceKey = JSON.stringify(sliceSource)
          if (sliceMetaKeyRef.current !== sliceKey) {
            setSliceMeta(sliceSource)
            sliceMetaKeyRef.current = sliceKey
          }
        } else if (sliceFailed) {
          const sliceSource = { status: 'failed', error: sliceJobError }
          const sliceKey = JSON.stringify(sliceSource)
          if (sliceMetaKeyRef.current !== sliceKey) {
            setSliceMeta(sliceSource)
            sliceMetaKeyRef.current = sliceKey
          }
        } else if (sliceRunning) {
          const sliceSource = { status: 'running' }
          const sliceKey = JSON.stringify(sliceSource)
          if (sliceMetaKeyRef.current !== sliceKey) {
            setSliceMeta(sliceSource)
            sliceMetaKeyRef.current = sliceKey
          }
        } else {
          // Fallback to asset-based slice_check metadata if no slice job
          const sliceSource = (asset && asset.meta_json?.slice_check) || latestRepaired?.meta_json?.slice_check || latestSized?.meta_json?.slice_check || null
          const sliceKey = sliceSource ? JSON.stringify(sliceSource) : null
          if (sliceMetaKeyRef.current !== sliceKey) {
            sliceMetaKeyRef.current = sliceKey
            setSliceMeta(sliceSource)
          }
        }
        if (latestSized?.signed_url) setPrintReadyUrl(latestSized.signed_url as string)
        else if (latestRepaired?.signed_url) setPrintReadyUrl(latestRepaired.signed_url as string)
        const waiting = !stabilizedAsset && statusForGate && generatingStates.has(statusForGate)
        const exportBusy = statusForGate === 'exporting'
        const meshMounted = Boolean(objectRef.current)
        const shouldClearForWaiting = waiting && !meshMounted && !awaitingTransformRef.current
        if (!cancelled) {
          console.debug('[Stage] waitingForMesh', shouldClearForWaiting)
          setWaitingForMesh(shouldClearForWaiting)
          const ready = Boolean(stabilizedAsset)
          setBasePrepare(ready && !waiting && !exportBusy)
        }
        if (exportPending && statusForGate) {
          const exportFailed = statusForGate === 'slice_failed' || statusForGate === 'needs_review'
          const exportAgeMs = pendingExportRequestedAtRef.current != null ? Date.now() - pendingExportRequestedAtRef.current : 0
          if (exportFailed) {
            clearPendingExport()
            clearAwaitingTransform()
            setPendingSize(false)
            setSizeStatus((prev) => (prev === 'processing' ? 'dirty' : prev))
            setNotice('Sized STL failed to prepare — adjust the mesh or retry.')
          } else if (statusForGate === 'stl_ready' && !latestSized && exportAgeMs > 10000) {
            // Worker reported completion but no sized asset materialized; reset the UI so users can retry.
            clearPendingExport()
            clearAwaitingTransform()
            setPendingSize(false)
            setPendingLongest(null)
            setSizeStatus((prev) => (prev === 'processing' ? 'dirty' : prev))
            setNotice('Sized STL did not arrive — original size is still ready. Try again in a moment.')
            setExportRetryHint(true)
          } else if (statusForGate !== 'exporting' && !latestSized) {
            setSizeStatus('processing')
            setNotice((prev) => prev || 'Preparing print‑ready STL…')
          }
        }
        if (shouldClearForWaiting) {
          // Do not mark expectation here; only the user/job-start should.
          currentAssetIdRef.current = null
          currentAssetCreatedAtRef.current = null
          currentKindRef.current = null
          modelUrlRef.current = null
          console.debug('[Stage] clearing toolpath and print-ready url while waiting')
          setPrintReadyUrl(null)
          setToolpathAsset(null)
          toolpathBBoxRef.current = null
          currentToolpathAssetIdRef.current = null
          setBasePrepare(false)
        } else if (!waiting && !asset && expectsMeshRef.current && !awaitingTransformRef.current) {
          setMeshExpectation(false)
        }
        if (latestToolpath?.signed_url) {
          const prev = toolpathAssetRef.current
          if (!prev || prev.id !== latestToolpath.id || prev.url !== latestToolpath.signed_url) {
            currentToolpathAssetIdRef.current = latestToolpath.id as string
            try { currentToolpathStorageUrlRef.current = (latestToolpath.url as string) || null } catch { currentToolpathStorageUrlRef.current = null }
            setToolpathAsset({ id: latestToolpath.id as string, url: latestToolpath.signed_url as string })
          }
        } else if (currentToolpathAssetIdRef.current) {
          currentToolpathAssetIdRef.current = null
          setToolpathAsset(null)
          toolpathBBoxRef.current = null
        }
        // If we expect a specific sized asset from the just-finished job, prefer it.
        if (expectedSizedAssetIdRef.current) {
          const wanted = assets.find((a: any) => a.id === expectedSizedAssetIdRef.current)
          if (wanted && wanted.signed_url) {
            considerCandidate({
              url: wanted.signed_url as string,
              ext: 'stl',
              kind: 'stl',
              assetKind: wanted.kind,
              assetId: wanted.id as string,
              createdAt: wanted.created_at || wanted.inserted_at || wanted.updated_at || null,
              source: 'poll',
              meta: wanted.meta_json,
            })
            expectedSizedAssetIdRef.current = null
          }
        }

        if (asset?.signed_url && !cancelled) {
          currentAssetInfoRef.current = { kind: asset.kind, meta: asset.meta_json }
          try { currentAssetStorageUrlRef.current = (asset.url as string) || null } catch { currentAssetStorageUrlRef.current = null }
          const hintFrom = (asset.url || asset.signed_url || '') as string
          let hintedExt: string | null = null
          try {
            const path = ((): string => {
              try { return new URL(hintFrom).pathname.toLowerCase() } catch { return (hintFrom.split('?')[0] || '').toLowerCase() }
            })()
            if (path.endsWith('.stl')) hintedExt = 'stl'
            else if (path.endsWith('.obj')) hintedExt = 'obj'
            else if (path.endsWith('.glb')) hintedExt = 'glb'
            else if (path.endsWith('.gltf')) hintedExt = 'gltf'
          } catch {}
          const accepted = considerCandidate({
            url: asset.signed_url as string,
            ext: hintedExt,
            kind: 'stl',
            assetKind: asset.kind,
            assetId: (asset.id as string) || null,
            createdAt: asset.created_at || asset.inserted_at || asset.updated_at || null,
            source: 'poll',
            meta: asset.meta_json,
          })
          if (accepted) {
            const exportPending = pendingExportRequestedAtRef.current != null
            if (!exportPending || asset.kind === 'repaired_sized_stl') {
              clearAwaitingTransform()
            }
            if (!exportPending || asset.kind === 'repaired_sized_stl') {
              setPendingLongest(null)
            }
            if (asset.kind === 'repaired_sized_stl') {
              userSizedRef.current = false
              const fallbackTarget =
                pendingExportTargetRef.current ??
                pendingTransformTargetRef.current ??
                committedLongestRef.current ??
                displayLongest
              applyWorkerLongest(asset.meta_json?.target_max_dim_mm, { fallback: fallbackTarget })
              setNotice(null)
              setExportRetryHint(false)
            } else if (asset.kind === 'repaired_stl') {
              if (!exportPending) {
                userSizedRef.current = false
                workerLongestRef.current = null
                committedLongestRef.current = null
                pendingTransformTargetRef.current = null
                const bbox = orientationSource?.bbox_mm
                const longestOrientation = bbox
                  ? Math.max(Number(bbox.x || 0), Number(bbox.y || 0), Number(bbox.z || 0))
                  : null
            if (longestOrientation != null && Number.isFinite(longestOrientation) && longestOrientation > 0) {
              const clampedLongest = clampLongest(longestOrientation)
              setReadyLongest(clampedLongest)
            }
                // Only mark clean if user hasn't drifted away from the baseline size
                setSizeStatus((prev) => {
                  const base = (readyLongest != null ? readyLongest : committedLongestRef.current)
                  const drift = base != null && Math.abs(Number(base) - displayLongest) >= 0.5
                  return drift ? prev : 'clean'
                })
                setNotice(null)
              }
            } else if (!exportPending) {
              setNotice(null)
            }
            const allowPrepare = statusForGate !== 'exporting' && (asset.kind === 'repaired_sized_stl' || asset.kind === 'repaired_stl')
            setBasePrepare(allowPrepare)
          }
        } else if (!asset && waiting) {
          currentAssetInfoRef.current = null
          setBasePrepare(false)
        }
      } catch (e: any) {
        if (!String(e?.message || '').includes('not_authenticated')) {
          console.warn('[Stage] polling error', e)
        }
        throw e
      }
    }
    // Backoff state
    let timer: ReturnType<typeof setTimeout> | null = null
    let errorCount = 0
    const baseDelay = 2000
    const maxDelay = 30000
    const scheduleNext = (ok: boolean) => {
      if (cancelled) return
      if (timer) { clearTimeout(timer); timer = null }
      if (ok) errorCount = 0
      const exp = Math.min(maxDelay, ok ? baseDelay : baseDelay * Math.pow(2, Math.min(errorCount, 4)))
      const jitter = Math.floor(exp * (0.2 * Math.random()))
      const delay = Math.max(1200, exp + jitter)
      timer = setTimeout(async () => {
        try {
          await poll()
          scheduleNext(true)
        } catch {
          errorCount += 1
          scheduleNext(false)
        }
      }, delay)
    }
    // Expose manual poll trigger
    pollRef.current = () => {
      if (cancelled) return
      if (timer) { clearTimeout(timer); timer = null }
      ;(async () => {
        try { await poll(); scheduleNext(true) } catch { errorCount += 1; scheduleNext(false) }
      })()
    }
    // Kick off immediately
    pollRef.current()
    return () => {
      cancelled = true
      if (timer) { clearTimeout(timer); timer = null }
      pollRef.current = () => {}
    }
  }, [orderId, authFetch, ensureTokenOrNotice, considerCandidate, clampLongest, displayLongest, applyWorkerLongest, clearAwaitingTransform, setPendingLongest, setReadyLongest, setSizeStatus])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        try {
          const maybe = pollRef.current?.()
          if (maybe instanceof Promise) maybe.catch(() => null)
        } catch {
          /* ignore */
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('../workers/gcodeWorker.ts', import.meta.url))
    worker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data
      if (!data) return
      if (data.type === 'result') {
        if (data.id && toolpathAssetRef.current?.id && data.id !== toolpathAssetRef.current.id) {
          return
        }
        const layers: ToolpathLayer[] = (data.layers || []).map((layer: any) => ({
          index: Number(layer.index) || 0,
          z: Number(layer.z) || 0,
          segments: (Array.isArray(layer.segments) ? layer.segments : []).map((seg: any) => ({
            kind: (seg.kind || 'perimeter') as FeatureKind,
            positions: new Float32Array(seg.buffer),
          })),
        }))
        toolpathBBoxRef.current = data.bbox || null
        const pendingId = pendingToolpathAssetIdRef.current
        const isFresh = Boolean(pendingId && (!data.id || data.id === pendingId))
        if (isFresh) pendingToolpathAssetIdRef.current = null
        setToolpathLayers(layers)
        setToolpathMode((prev) => {
          if (isFresh) return layers.length > 0
          return prev && layers.length > 0
        })
        setToolpathLoading(false)
        setToolpathError(null)
        const nextDefault = layers.length ? layers.length - 1 : 0
        if (isFresh) {
          setToolLayerIndex(nextDefault)
        } else {
          setToolLayerIndex((prev) => {
            if (!layers.length) return 0
            if (prev >= layers.length || prev < 0) return layers.length - 1
            return prev
          })
        }
      } else if (data.type === 'error') {
        if (data.id && toolpathAssetRef.current?.id && data.id !== toolpathAssetRef.current.id) {
          return
        }
        if (!data.id || data.id === pendingToolpathAssetIdRef.current) {
          pendingToolpathAssetIdRef.current = null
        }
        setToolpathError(data.message || 'Failed to parse toolpath')
        setToolpathLoading(false)
      }
    }
    worker.onerror = (err) => {
      setToolpathError(err.message || 'Toolpath worker error')
      setToolpathLoading(false)
    }
    toolpathWorkerRef.current = worker
    return () => {
      worker.terminate()
      toolpathWorkerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!toolpathAsset) {
      setToolpathLayers([])
      setToolpathMode(false)
      setToolpathLoading(false)
      setToolpathError(null)
      clearToolpathGroup()
      pendingToolpathAssetIdRef.current = null
      return
    }
    const worker = toolpathWorkerRef.current
    if (!worker) return
    pendingToolpathAssetIdRef.current = toolpathAsset.id
    setToolpathLoading(true)
    setToolpathError(null)
    ;(async () => {
      try {
        const res = await fetch(toolpathAsset.url, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const buffer = await res.arrayBuffer()
        toolpathBBoxRef.current = null
        worker.postMessage({ type: 'parse', buffer, id: toolpathAsset.id }, [buffer])
      } catch (err: any) {
        // Attempt to re-sign on 401/403 using canonical storage URL
        const statusText = String(err?.message || '')
        const codeMatch = statusText.match(/HTTP\s+(\d{3})/)
        const statusCode = codeMatch ? Number(codeMatch[1]) : null
        if ((statusCode === 401 || statusCode === 403) && orderId && currentToolpathStorageUrlRef.current) {
          try {
            const signRes = await authFetch('/api/storage/sign', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId, urls: [currentToolpathStorageUrlRef.current] }),
            })
            if (signRes.ok) {
              const data = await signRes.json().catch(() => null)
              const next = Array.isArray(data?.results) && data.results[0]?.url ? String(data.results[0].url) : null
              if (next) {
                const res2 = await fetch(next, { cache: 'no-store' })
                if (res2.ok) {
                  const buffer = await res2.arrayBuffer()
                  toolpathBBoxRef.current = null
                  worker.postMessage({ type: 'parse', buffer, id: toolpathAsset.id }, [buffer])
                  return
                }
              }
            }
          } catch {}
        }
        setToolpathLoading(false)
        setToolpathError(err?.message || 'Failed to load toolpath')
      }
    })()
  }, [toolpathAsset, clearToolpathGroup])

  useEffect(() => {
    if (!mountRef.current) return
    const el = mountRef.current
    const scene = new THREE.Scene(); sceneRef.current = scene
    const camera = new THREE.PerspectiveCamera(50, el.clientWidth / el.clientHeight, 0.1, 1000); cameraRef.current = camera
    camera.position.set(2, 2, 2)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    rendererRef.current = renderer
    // Color/tone mapping for better shading
    // @ts-ignore
    renderer.outputColorSpace = THREE.SRGBColorSpace
    // @ts-ignore
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.setClearColor(0x000000, 0)
    renderer.setSize(el.clientWidth, el.clientHeight)
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)
    // Ensure the canvas always fills the container box to avoid visual left bias
    try {
      const canvas = renderer.domElement as HTMLCanvasElement
      canvas.style.width = '100%'
      canvas.style.height = '100%'
      canvas.style.display = 'block'
    } catch {}
    const controls = new OrbitControls(camera, renderer.domElement); controlsRef.current = controls
    controls.enableDamping = true
    const handleControlsChange = () => {
      if (!cameraRef.current || !controlsRef.current) return
      const currentCamera = cameraRef.current
      const currentControls = controlsRef.current
      if (!cameraOffsetRef.current) {
        cameraOffsetRef.current = currentCamera.position.clone().sub(currentControls.target)
      } else {
        cameraOffsetRef.current.copy(currentCamera.position).sub(currentControls.target)
      }
    }
    controls.addEventListener('change', handleControlsChange)
    const ambient = new THREE.AmbientLight(0xffffff, 0.4)
    scene.add(ambient)
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.6)
    scene.add(hemi)
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(200, 300, 400)
    scene.add(dir)

    const material = new THREE.MeshStandardMaterial({ color: 0x8fd2ca, metalness: 0.1, roughness: 0.75 });
    materialRef.current = material
    const toolMaterials: Record<FeatureKind, THREE.LineBasicMaterial> = {
      perimeter: new THREE.LineBasicMaterial({ color: 0xffa347, opacity: 0.9, transparent: true }),
      infill: new THREE.LineBasicMaterial({ color: 0x2ee6d6, opacity: 0.55, transparent: true }),
      support: new THREE.LineBasicMaterial({ color: 0x8f8fff, opacity: 0.85, transparent: true }),
    }
    toolMaterialsRef.current = toolMaterials
    const stlLoader = new STLLoader();
    const gltfLoader = new GLTFLoader();
    try {
      // Enable meshopt if a GLB includes EXT_meshopt_compression
      gltfLoader.setMeshoptDecoder(MeshoptDecoder)
    } catch {}
    // Enable DRACO for compressed GLB/GLTF assets returned by generators
    try {
      const draco = new DRACOLoader()
      // Use a CDN for decoders to avoid bundling; Next.js will fetch from browser
      draco.setDecoderConfig({ type: 'js' })
      draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/')
      gltfLoader.setDRACOLoader(draco)
    } catch {}
    const objLoader = new OBJLoader();

    // Build volume for Bambu X1C in millimeters
    const VOL_X = BUILD_VOLUME_X_MM
    const VOL_Y = BUILD_VOLUME_Y_MM
    const VOL_Z = BUILD_VOLUME_Z_MM

    // Major lines every 50 mm (bed grid overlay)
    const lines: THREE.Vector3[] = []
    const halfX = VOL_X / 2
    const halfZ = VOL_Z / 2
    for (let x = -halfX; x <= halfX; x += 50) {
      lines.push(new THREE.Vector3(x, 0.01, -halfZ), new THREE.Vector3(x, 0.01, halfZ))
    }
    for (let z = -halfZ; z <= halfZ; z += 50) {
      lines.push(new THREE.Vector3(-halfX, 0.01, z), new THREE.Vector3(halfX, 0.01, z))
    }
    const geom = new THREE.BufferGeometry().setFromPoints(lines)
    const mat = new THREE.LineBasicMaterial({ color: 0x2ee6d6, opacity: 0.25, transparent: true })
    const seg = new THREE.LineSegments(geom, mat)
    scene.add(seg)
    // Volume cage (mm)
    const boxGeom = new THREE.BoxGeometry(VOL_X, VOL_Y, VOL_Z)
    const edges = new THREE.EdgesGeometry(boxGeom)
    const cage = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x2ee6d6, opacity: 0.08, transparent: true }))
    cage.position.y = VOL_Y / 2
    scene.add(cage)

    function disposeObject(obj: THREE.Object3D | null) {
      if (!obj) return
      try {
        const shared = materialRef.current
        obj.traverse((child: any) => {
          if (child.geometry) {
            const sharedGeom = child.geometry?.userData?.__replicatorShared === true
            if (!sharedGeom) child.geometry.dispose()
          }
          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material]
            for (const m of mats) {
              if (!m) continue
              if (shared && m === shared) continue
              try { m.dispose() } catch {}
            }
          }
        })
      } catch {}
    }

    function clearObject() {
      const prev = objectRef.current
      if (prev) {
        scene.remove(prev)
        disposeObject(prev)
      }
      objectRef.current = null
      baseScaleRef.current = null
      baseMaxDimRef.current = null
      pendingInitialPlacementRef.current = false
      committedLongestRef.current = null
      workerLongestRef.current = null
      sizingActiveRef.current = false
      setSizingActive(false)
      currentKindRef.current = null
      currentAssetIdRef.current = null
      currentAssetKeyRef.current = null
      currentAssetCreatedAtRef.current = null
      modelUrlRef.current = null
      currentAssetInfoRef.current = null
      setHasModel(false)
    }
    clearSceneRef.current = clearObject

    function installObject(next: THREE.Object3D) {
      const prev = objectRef.current
      if (prev) {
        scene.add(next)
        objectRef.current = next
        scene.remove(prev)
        disposeObject(prev)
      } else {
        scene.add(next)
        objectRef.current = next
      }
      setHasModel(true)
    }

    function fitCameraToObject(obj: THREE.Object3D, options?: CameraFocusOptions) {
      if (!cameraRef.current || !controlsRef.current) return
      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const target = center.clone()
      const camera = cameraRef.current
      const controls = controlsRef.current
      controls.target.copy(target)

      const requiredDist = (Math.max(size.x, size.y, size.z) / Math.tan((camera.fov * Math.PI) / 360)) * 1.4
      const defaultDir = new THREE.Vector3(1, 0.9, 1).normalize()
      const currentOffset = cameraOffsetRef.current
      const hasPriorOffset = currentOffset && currentOffset.lengthSq() > 1e-8
      const priorOffset = hasPriorOffset ? currentOffset!.clone() : null

      let offset = defaultDir.clone().multiplyScalar(requiredDist)
      if (priorOffset) {
        const priorDist = priorOffset.length()
        const dir = priorOffset.normalize()
        if (options?.mode === 'fit') {
          offset = dir.multiplyScalar(Math.max(priorDist, requiredDist))
        } else {
          offset = dir.multiplyScalar(priorDist)
        }
      }

      camera.position.copy(target.clone().add(offset))
      if (!cameraOffsetRef.current) cameraOffsetRef.current = offset.clone()
      else cameraOffsetRef.current.copy(offset)
      const distNow = offset.length()
      camera.near = Math.max(0.1, distNow / 500)
      camera.far = Math.max(camera.near * 10, distNow * 500)
      camera.updateProjectionMatrix()
      controls.update()
    }
    fitCameraToObjectRef.current = fitCameraToObject

    // Shrink object to fit volume with a comfortable display margin (do not scale up)
    function clampToVolume(obj: THREE.Object3D) {
      const margin = Math.max(0, BUILD_VOLUME_MARGIN_MM)
      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3())
      const sx = (VOL_X - margin) / Math.max(1e-6, size.x)
      const sy = (VOL_Y - margin) / Math.max(1e-6, size.y)
      const sz = (VOL_Z - margin) / Math.max(1e-6, size.z)
      const s = Math.min(1, sx, sy, sz)
      if (s < 1) {
        obj.scale.multiplyScalar(s)
        obj.updateMatrixWorld(true)
      }
    }
    clampToVolumeRef.current = clampToVolume

    function autoOrientObject(obj: THREE.Object3D | null) {
      if (!obj) return
      const basePos = obj.position.clone()
      const baseQuat = obj.quaternion.clone()
      const baseScale = obj.scale.clone()
      const candidates: Array<[number, number, number]> = [
        [0, 0, 0],
        [Math.PI / 2, 0, 0],
        [-Math.PI / 2, 0, 0],
        [0, Math.PI / 2, 0],
        [0, -Math.PI / 2, 0],
        [0, 0, Math.PI / 2],
        [0, 0, -Math.PI / 2],
      ]
      const tmpQuat = new THREE.Quaternion()
      const tmpEuler = new THREE.Euler()
      const tmpVec = new THREE.Vector3()
      let bestScore = -Infinity
      const bestState = {
        quat: baseQuat.clone(),
        pos: basePos.clone(),
      }

      const evaluateScore = () => {
        const box = new THREE.Box3().setFromObject(obj)
        const size = box.getSize(new THREE.Vector3())
        const dx = size.x
        const dy = size.y
        const dz = size.z
        const baseArea = dx * dz
        const dims = [dx, dy, dz].sort((a, b) => a - b)
        const slenderRatio = dims[2] / Math.max(1e-6, dims[0])
        const yIsLongest = dy >= dx && dy >= dz
        const uprightBonus = slenderRatio >= 1.35 && yIsLongest ? 5000 : 0
        const minY = box.min.y
        let contact = 0
        obj.traverse((child: any) => {
          if (!child?.isMesh) return
          const geom = child.geometry as THREE.BufferGeometry | undefined
          if (!geom?.attributes?.position) return
          const attr = geom.attributes.position as THREE.BufferAttribute
          if (!attr || !attr.count) return
          const stride = Math.max(1, Math.floor(attr.count / 50000))
          const matrixWorld = child.matrixWorld
          for (let i = 0; i < attr.count; i += stride) {
            tmpVec.fromBufferAttribute(attr, i)
            tmpVec.applyMatrix4(matrixWorld)
            if (tmpVec.y - minY <= 0.3) contact += 1
          }
        })
        return uprightBonus + contact * 5 + baseArea * 0.001
      }

      for (const [rx, ry, rz] of candidates) {
        obj.position.copy(basePos)
        obj.quaternion.copy(baseQuat)
        obj.scale.copy(baseScale)
        obj.updateMatrixWorld(true)
        if (rx !== 0 || ry !== 0 || rz !== 0) {
          tmpEuler.set(rx, ry, rz, 'XYZ')
          tmpQuat.setFromEuler(tmpEuler)
          obj.quaternion.multiply(tmpQuat)
        }
        obj.updateMatrixWorld(true)
        seatOnBed(obj)
        obj.updateMatrixWorld(true)
        const score = evaluateScore()
        if (score > bestScore) {
          bestScore = score
          bestState.quat.copy(obj.quaternion)
          bestState.pos.copy(obj.position)
        }
      }

      obj.quaternion.copy(bestState.quat)
      obj.position.copy(bestState.pos)
      obj.scale.copy(baseScale)
      obj.updateMatrixWorld(true)
    }

    // Rotation helpers
    rotateAndSeatRef.current = (axis: 'x'|'y'|'z', quarterTurns = 1) => {
      const obj = objectRef.current
      if (!obj) return
      const angle = (Math.PI / 2) * (quarterTurns % 4)
      if (axis === 'x') obj.rotateX(angle)
      if (axis === 'y') obj.rotateY(angle)
      if (axis === 'z') obj.rotateZ(angle)
      obj.updateMatrixWorld(true)
      seatOnBed(obj)
      clampToVolume(obj)
      obj.updateMatrixWorld(true)
      try { fitCameraToObjectRef.current?.(obj, { mode: 'maintain' }) } catch {}
    }
    uprightRef.current = () => {
      const obj = objectRef.current
      if (!obj) return
      const box = new THREE.Box3().setFromObject(obj)
      const s = box.getSize(new THREE.Vector3())
      const dims = [{a:'x',v:s.x},{a:'y',v:s.y},{a:'z',v:s.z}] as any[]
      dims.sort((a,b)=>b.v-a.v)
      const longest = dims[0].a as 'x'|'y'|'z'
      if (longest === 'x') rotateAndSeatRef.current('z', 1) // x->y
      else if (longest === 'z') rotateAndSeatRef.current('x', -1) // z->y
      else { seatOnBed(obj); clampToVolume(obj) }
    }

    function fitCameraToBed() {
      const maxDim = Math.max(VOL_X, VOL_Z)
      const dist = (maxDim / Math.tan((camera.fov * Math.PI) / 360)) * 1.2
      const defaultDir = new THREE.Vector3(1, 0.9, 1).normalize()
      const currentOffset = cameraOffsetRef.current
      const hasPriorOffset = currentOffset && currentOffset.lengthSq() > 1e-8
      const priorDir = hasPriorOffset ? currentOffset!.clone().normalize() : defaultDir
      const targetY = VOL_Y * 0.3125
      controls.target.set(0, targetY, 0)
      const offset = priorDir.clone().multiplyScalar(dist)
      camera.position.copy(controls.target.clone().add(offset))
      if (!cameraOffsetRef.current) cameraOffsetRef.current = offset.clone()
      else cameraOffsetRef.current.copy(offset)
      camera.near = Math.max(0.1, dist / 500)
      camera.far = dist * 500
      camera.updateProjectionMatrix()
      controls.update()
    }

    function getExt(u: string): string {
      try {
        const p = new URL(u).pathname.toLowerCase()
        if (p.endsWith('.stl')) return 'stl'
        if (p.endsWith('.glb')) return 'glb'
        if (p.endsWith('.gltf')) return 'gltf'
        if (p.endsWith('.obj')) return 'obj'
      } catch {}
      const s = u.split('?')[0].toLowerCase()
      if (s.endsWith('.stl')) return 'stl'
      if (s.endsWith('.glb')) return 'glb'
      if (s.endsWith('.gltf')) return 'gltf'
      if (s.endsWith('.obj')) return 'obj'
      return ''
    }

    loadModelRef.current = (url: string) => {
      // Invalidate any in-flight load but keep current mesh visible until replacement succeeds
      loadSeqRef.current += 1
      const mySeq = loadSeqRef.current
      userSizedRef.current = false
      const ext = getExt(url)
      if (ext) setModelExt(ext)
      if (ext === 'stl') {
        const assetKey = currentAssetKeyRef.current
        const cachedBuffer = getCachedStlBuffer(assetKey)

        const processBuffer = async (buffer: ArrayBuffer) => {
          // Use stash first
          const stashKey = currentAssetStorageUrlRef.current || assetKey || url
          const stashed = getStashedGeometry(stashKey)
          let geometry: THREE.BufferGeometry | null = null
          if (stashed) {
            geometry = stashed
          } else {
            // Try off-thread parsing
            let parsed: { positions: Float32Array; normals: Float32Array } | null = null
            try {
              if (!(parseWorkerRef.current)) {
                // @ts-ignore
                parseWorkerRef.current = new Worker(new URL('../workers/modelParser.ts', import.meta.url), { type: 'module' })
              }
              const worker: Worker = parseWorkerRef.current!
              parsed = await new Promise((resolve) => {
                const onMessage = (ev: MessageEvent) => {
                  const d = ev.data || {}
                  if (d && d.type === 'stl') {
                    worker.removeEventListener('message', onMessage)
                    if (d.ok && d.positions && d.normals) {
                      resolve({ positions: new Float32Array(d.positions), normals: new Float32Array(d.normals) })
                    } else {
                      resolve(null)
                    }
                  }
                }
                worker.addEventListener('message', onMessage)
                // Send a copy to the worker so the original remains usable for fallback
                // Transferring the original would detach it, breaking STLLoader.parse fallback
                let wb: ArrayBuffer
                try { wb = buffer.slice(0) } catch { wb = buffer }
                try { worker.postMessage({ type: 'parse-stl', bytes: wb }, [wb]) } catch { worker.postMessage({ type: 'parse-stl', bytes: wb }) }
              })
            } catch {}
            if (parsed) {
              const geom = new THREE.BufferGeometry()
              geom.setAttribute('position', new THREE.BufferAttribute(parsed.positions, 3))
              geom.setAttribute('normal', new THREE.BufferAttribute(parsed.normals, 3))
              geometry = geom
            } else {
              // Fallback to main-thread STLLoader
              const g: THREE.BufferGeometry = stlLoader.parse(buffer)
              g.computeVertexNormals()
              geometry = g
            }
            geometry.computeBoundingBox()
          }
          const bb = geometry.boundingBox!
          const size = new THREE.Vector3(); bb.getSize(size)
          console.debug('[Stage] STL bbox (pre-scale)', size.toArray())
          // Heuristic: if STL is tiny (< 2 units), assume meters -> scale to mm.
          // For repaired STLs we normally skip to avoid double scaling, but if the
          // asset meta indicates millimeter bbox far larger than the geometry units,
          // apply the correction to prevent the "tiny rocket" problem.
          const maxDim = Math.max(size.x, size.y, size.z)
          let scaleFactor = 1
          const kNowTiny = (currentAssetInfoRef.current?.kind || '') as string
          const tinyIsRepaired = kNowTiny === 'repaired_stl' || kNowTiny === 'repaired_sized_stl'
          if (maxDim > 0 && maxDim < 2) {
            if (!tinyIsRepaired) {
              scaleFactor = 1000
            } else {
              try {
                const meta = currentAssetInfoRef.current?.meta || null
                const bbox = (meta?.bbox_mm || meta?.orient_clamp?.bbox_mm || null) as any
                const longestMeta = bbox ? Math.max(Number(bbox.x||0), Number(bbox.y||0), Number(bbox.z||0)) : null
                if (longestMeta != null && Number.isFinite(longestMeta) && longestMeta > 10) {
                  scaleFactor = 1000
                }
              } catch {}
            }
          }
          if (scaleFactor !== 1) geometry.scale(scaleFactor, scaleFactor, scaleFactor)
          // Many STLs are Z-up. Convert to our Y-up viewer by rotating -90° about X.
          geometry.rotateX(-Math.PI / 2)
          // Recompute after transform
          geometry.computeBoundingBox()
          const bb2 = geometry.boundingBox!
          const center = new THREE.Vector3(); bb2.getCenter(center)
          // Seat on bed: center XZ, base at y=0 (mm units)
          geometry.translate(-center.x, -bb2.min.y, -center.z)
          // Mark as shared so we don't dispose it on future replace and stash it for re-use
          try { (geometry as any).userData = { ...(geometry as any).userData, __replicatorShared: true } } catch {}
          try { stashGeometry(stashKey, geometry) } catch {}
          // If a newer load started, drop this result silently
          if (mySeq !== loadSeqRef.current) {
            const sharedGeom = (geometry as any)?.userData?.__replicatorShared === true
            if (!sharedGeom) geometry.dispose()
            return
          }
          const existing = objectRef.current
          if (existing && (existing as any).isMesh && existing.material === material) {
            const prevMesh = existing as THREE.Mesh
            try {
              const sharedGeomPrev = (prevMesh.geometry as any)?.userData?.__replicatorShared === true
              if (!sharedGeomPrev) prevMesh.geometry?.dispose?.()
            } catch {}
            prevMesh.geometry = geometry
            // If this is a sized, repaired STL, do not pre-clamp; we'll apply
            // an exact target scale below which maintains intended mm size.
            {
              const kNow = (currentAssetInfoRef.current?.kind || '') as string
              const meta = currentAssetInfoRef.current?.meta || null
              const t = meta && typeof meta.target_max_dim_mm === 'number' ? Number(meta.target_max_dim_mm) : null
              const isSized = kNow === 'repaired_sized_stl' && t && t > 0
              if (!isSized) {
                clampToVolume(prevMesh)
              }
            }
            prevMesh.updateMatrixWorld(true)
            const box = new THREE.Box3().setFromObject(prevMesh)
            const size3 = box.getSize(new THREE.Vector3())
            baseScaleRef.current = prevMesh.scale.clone()
            baseMaxDimRef.current = Math.max(size3.x, size3.y, size3.z)
            console.debug('[Stage] STL bbox (post-update)', size3.toArray())
            pendingInitialPlacementRef.current = true
            { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
          } else {
            const mesh = new THREE.Mesh(geometry, material)
            // Skip pre-clamp for sized STLs; exact target scaling will follow.
            {
              const kNow = (currentAssetInfoRef.current?.kind || '') as string
              const meta = currentAssetInfoRef.current?.meta || null
              const t = meta && typeof meta.target_max_dim_mm === 'number' ? Number(meta.target_max_dim_mm) : null
              const isSized = kNow === 'repaired_sized_stl' && t && t > 0
              if (!isSized) {
                clampToVolume(mesh)
              }
            }
            mesh.updateMatrixWorld(true)
            installObject(mesh)
            { const box = new THREE.Box3().setFromObject(mesh); const size3 = box.getSize(new THREE.Vector3()); baseScaleRef.current = mesh.scale.clone(); baseMaxDimRef.current = Math.max(size3.x, size3.y, size3.z); console.debug('[Stage] STL bbox (post-load)', size3.toArray()) }
            pendingInitialPlacementRef.current = true
            { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
          }
        }

        if (cachedBuffer) {
          processBuffer(cachedBuffer)
          return
        }

        // Try persistent Cache Storage for instant paint (then refresh via network)
        ;(async () => {
          try {
            const storageUrl = currentAssetStorageUrlRef.current
            const ab = await readStlFromPersistentCache(storageUrl)
            if (ab) {
              // Do not update in-memory LRU here; network path below will refresh it
              if (mySeq === loadSeqRef.current) processBuffer(ab)
            }
          } catch {}
        })().catch(() => {})

        // Abort any in-flight STL fetch
        try { stlAbortRef.current?.abort() } catch {}
        stlAbortRef.current = new AbortController()
        // Fetch manually to avoid edge CORS issues, then parse
        const tryFetch = async (u: string, allowResign = true): Promise<void> => {
          const res = await fetch(u, { mode: 'cors', cache: 'no-store', credentials: 'omit', signal: stlAbortRef.current!.signal })
          if (!res.ok) {
            // Attempt to re-sign on 401/403 using canonical storage URL
            if (allowResign && (res.status === 401 || res.status === 403)) {
              try {
                const storageUrl = currentAssetStorageUrlRef.current
                if (orderId && storageUrl) {
                  const signRes = await authedFetch('/api/storage/sign', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orderId, urls: [storageUrl] }),
                  })
                  if (signRes.ok) {
                    const data = await signRes.json().catch(() => null)
                    const next = Array.isArray(data?.results) && data.results[0]?.url ? String(data.results[0].url) : null
                    if (next) {
                      modelUrlRef.current = next
                      await tryFetch(next, false)
                      return
                    }
                  }
                }
              } catch {}
            }
            throw new Error(`HTTP ${res.status}`)
          }
            const ab = await res.arrayBuffer()
            if (assetKey) {
              cacheStlBuffer(assetKey, ab)
            }
            // Persist for future reloads keyed by canonical storage URL
            try { await writeStlToPersistentCache(currentAssetStorageUrlRef.current, ab) } catch {}
            processBuffer(ab)
          }
        tryFetch(url).catch((err) => {
            const msg = String(err?.message || '').toLowerCase()
            if (err?.name === 'AbortError' || msg.includes('aborted a request')) return
            console.warn('STL fetch/parse error', err)
            setNotice(`Failed to load STL: ${err?.message || err}`)
          })
      } else if (ext === 'glb' || ext === 'gltf') {
        gltfLoader.load(url, (g: any) => {
          const obj = g.scene || g.scenes?.[0]
          if (!obj) return
          // Decide unit scaling: our viewer GLBs are already in millimeters; raw/upload GLBs are meters → scale ×1000
          try {
            const meta = currentAssetInfoRef.current?.meta || null
            const isViewerGlb = Boolean(meta && (meta.viewer === true || meta.viewer_glb === true))
            if (!isViewerGlb) {
              obj.scale.multiplyScalar(1000)
            }
          } catch {
            obj.scale.multiplyScalar(1000)
          }
          obj.updateMatrixWorld(true)
          autoOrientObject(obj)
          try {
            const meta = currentAssetInfoRef.current?.meta || null
            const isViewerGlb = Boolean(meta && (meta.viewer === true || meta.viewer_glb === true))
            // Skip pre-clamp for viewer GLBs that are sized; exact scaling helper will clamp if needed
            if (!isViewerGlb) clampToVolume(obj)
          } catch { clampToVolume(obj) }
          seatOnBed(obj)
          if (mySeq !== loadSeqRef.current) {
            try { obj.traverse((child: any) => { child.geometry?.dispose?.(); if (child.material) { if (Array.isArray(child.material)) child.material.forEach((m:any)=>m.dispose()); else child.material.dispose() } }) } catch {}
            return
          }
          installObject(obj)
          { const box = new THREE.Box3().setFromObject(obj); const size3 = box.getSize(new THREE.Vector3()); baseScaleRef.current = obj.scale.clone(); baseMaxDimRef.current = Math.max(size3.x, size3.y, size3.z); console.debug('[Stage] GLB bbox (post-load)', size3.toArray()) }
          pendingInitialPlacementRef.current = true
          { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
        }, () => {}, (err: any) => {
          console.warn('GLTF load error', err)
          setNotice(`Failed to load GLB/GLTF: ${err?.message || err}`)
        })
      } else if (ext === 'obj') {
        objLoader.load(url, (obj: any) => {
          // Compute normals where possible and seat on bed
          obj.traverse((child: any) => {
            if (child.isMesh && child.geometry && child.geometry.computeVertexNormals) {
              child.geometry.computeVertexNormals()
              if (!child.material) child.material = material
            }
          })
          // Heuristic: if OBJ is tiny (<2 units), assume meters -> scale to mm
          const box0 = new THREE.Box3().setFromObject(obj)
          const size0 = box0.getSize(new THREE.Vector3())
          const maxDim0 = Math.max(size0.x, size0.y, size0.z)
          if (maxDim0 > 0 && maxDim0 < 2) {
            obj.scale.multiplyScalar(1000)
            obj.updateMatrixWorld(true)
          }
          autoOrientObject(obj)
          clampToVolume(obj)
          seatOnBed(obj)
          if (mySeq !== loadSeqRef.current) {
            try { obj.traverse((child: any) => { child.geometry?.dispose?.(); if (child.material) { if (Array.isArray(child.material)) child.material.forEach((m:any)=>m.dispose()); else child.material.dispose() } }) } catch {}
            return
          }
          installObject(obj)
          { const box = new THREE.Box3().setFromObject(obj); const size3 = box.getSize(new THREE.Vector3()); baseScaleRef.current = obj.scale.clone(); baseMaxDimRef.current = Math.max(size3.x, size3.y, size3.z); console.debug('[Stage] OBJ bbox (post-load)', size3.toArray()) }
          pendingInitialPlacementRef.current = true
          { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
        }, () => {}, (err: any) => {
          console.warn('OBJ load error', err)
          setNotice(`Failed to load OBJ: ${err?.message || err}`)
        })
      } else {
        // Fallback: try hinted ext from local preview first
        const hinted = modelExtRef.current
        if (hinted === 'obj') {
          objLoader.load(url, (obj: any) => {
            const box = new THREE.Box3().setFromObject(obj)
            const size = box.getSize(new THREE.Vector3())
            const maxDim = Math.max(size.x, size.y, size.z)
            if (maxDim > 0 && maxDim < 2) {
              obj.scale.multiplyScalar(1000)
              obj.updateMatrixWorld(true)
            }
            autoOrientObject(obj)
            clampToVolume(obj)
            seatOnBed(obj)
            installObject(obj)
            { const box2 = new THREE.Box3().setFromObject(obj); const size2 = box2.getSize(new THREE.Vector3()); baseScaleRef.current = obj.scale.clone(); baseMaxDimRef.current = Math.max(size2.x, size2.y, size2.z); console.debug('[Stage] OBJ-fallback bbox (post-load)', size2.toArray()) }
            pendingInitialPlacementRef.current = true
            { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
      })
      return
    }
    if (hinted === 'glb' || hinted === 'gltf') {
          gltfLoader.load(url, (g: any) => {
            const obj = g.scene || g.scenes?.[0]
            if (!obj) return
            obj.scale.multiplyScalar(1000)
            obj.updateMatrixWorld(true)
            autoOrientObject(obj)
            // Only clamp non-sized assets; sized STLs use exact target scaling.
            {
              const kNow = (currentAssetInfoRef.current?.kind || '') as string
              const meta = currentAssetInfoRef.current?.meta || null
              const t = meta && typeof meta.target_max_dim_mm === 'number' ? Number(meta.target_max_dim_mm) : null
              const isSized = kNow === 'repaired_sized_stl' && t && t > 0
              if (!isSized) {
                clampToVolume(obj)
              }
            }
            seatOnBed(obj)
            installObject(obj)
            { const box3 = new THREE.Box3().setFromObject(obj); const size3 = box3.getSize(new THREE.Vector3()); baseScaleRef.current = obj.scale.clone(); baseMaxDimRef.current = Math.max(size3.x, size3.y, size3.z); console.debug('[Stage] GLB-fallback bbox (post-load)', size3.toArray()) }
            pendingInitialPlacementRef.current = true
            { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
      })
          return
        }
        stlLoader.load(url, (geometry: THREE.BufferGeometry) => {
          geometry.computeVertexNormals(); geometry.computeBoundingBox(); const bb = geometry.boundingBox!; const c = bb.getCenter(new THREE.Vector3()); geometry.translate(-c.x, -bb.min.y, -c.z)
          const existing = objectRef.current
          if (existing && (existing as any).isMesh && existing.material === material) {
            const prevMesh = existing as THREE.Mesh
            try { prevMesh.geometry?.dispose?.() } catch {}
            prevMesh.geometry = geometry
            // Avoid pre-clamp for sized assets; exact scaling will be applied.
            {
              const kNow = (currentAssetInfoRef.current?.kind || '') as string
              const meta = currentAssetInfoRef.current?.meta || null
              const t = meta && typeof meta.target_max_dim_mm === 'number' ? Number(meta.target_max_dim_mm) : null
              const isSized = kNow === 'repaired_sized_stl' && t && t > 0
              if (!isSized) {
                clampToVolume(prevMesh)
              }
            }
            prevMesh.updateMatrixWorld(true)
            const box = new THREE.Box3().setFromObject(prevMesh)
            const size4 = box.getSize(new THREE.Vector3())
            baseScaleRef.current = prevMesh.scale.clone()
            baseMaxDimRef.current = Math.max(size4.x, size4.y, size4.z)
            console.debug('[Stage] STL-fallback bbox (post-update)', size4.toArray())
            pendingInitialPlacementRef.current = true
            { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
          } else {
            const mesh = new THREE.Mesh(geometry, material)
            // Avoid pre-clamp for sized assets; exact scaling will be applied.
            {
              const kNow = (currentAssetInfoRef.current?.kind || '') as string
              const meta = currentAssetInfoRef.current?.meta || null
              const t = meta && typeof meta.target_max_dim_mm === 'number' ? Number(meta.target_max_dim_mm) : null
              const isSized = kNow === 'repaired_sized_stl' && t && t > 0
              if (!isSized) {
                clampToVolume(mesh)
              }
            }
            mesh.updateMatrixWorld(true)
            installObject(mesh)
            { const box4 = new THREE.Box3().setFromObject(mesh); const size4 = box4.getSize(new THREE.Vector3()); baseScaleRef.current = mesh.scale.clone(); baseMaxDimRef.current = Math.max(size4.x, size4.y, size4.z); console.debug('[Stage] STL-fallback bbox (post-load)', size4.toArray()) }
            pendingInitialPlacementRef.current = true
            { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
          }
        }, () => {}, () => {
          gltfLoader.load(url, (g: any) => {
            const obj = g.scene || g.scenes?.[0]
            if (!obj) return
            obj.scale.multiplyScalar(1000)
            obj.updateMatrixWorld(true)
            autoOrientObject(obj)
            // Only clamp non-sized assets; sized STLs use exact target scaling.
            {
              const kNow = (currentAssetInfoRef.current?.kind || '') as string
              const meta = currentAssetInfoRef.current?.meta || null
              const t = meta && typeof meta.target_max_dim_mm === 'number' ? Number(meta.target_max_dim_mm) : null
              const isSized = kNow === 'repaired_sized_stl' && t && t > 0
              if (!isSized) {
                clampToVolume(obj)
              }
            }
            seatOnBed(obj)
            installObject(obj)
            { const box5 = new THREE.Box3().setFromObject(obj); const size5 = box5.getSize(new THREE.Vector3()); baseScaleRef.current = obj.scale.clone(); baseMaxDimRef.current = Math.max(size5.x, size5.y, size5.z); console.debug('[Stage] GLB-fallback2 bbox (post-load)', size5.toArray()) }
            pendingInitialPlacementRef.current = true
            { applyAdoptionScaleForCurrentAsset(baseMaxDimRef.current) }
          })
        })
      }
    }

    const onResize = () => {
      if (!el) return
      const w = el.clientWidth
      const h = el.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
    }
    window.addEventListener('resize', onResize)

    // Also observe container size changes (rail expand/collapse, layout shifts)
    let ro: ResizeObserver | null = null
    let resizeRaf: number | null = null
    const scheduleResize = () => {
      if (resizeRaf != null) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        onResize()
      })
    }
    try {
      if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
        ro = new ResizeObserver(() => scheduleResize())
        ro.observe(el)
      }
    } catch {}

    // Set a sensible initial view framing the bed
    fitCameraToBed()
    // Recenter once after layout settles to avoid first-frame mis-measure
    try { requestAnimationFrame(() => fitCameraToBed()) } catch {}

    let raf: number
    const animate = () => {
      raf = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const cleanup = () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      try { if (ro) ro.disconnect() } catch {}
      if (resizeRaf != null) { try { cancelAnimationFrame(resizeRaf) } catch {} }
      try { parseWorkerRef.current?.terminate?.() } catch {}
      clearToolpathGroup()
      controls.removeEventListener('change', handleControlsChange)
      controls.dispose()
      if (toolMaterialsRef.current) {
        Object.values(toolMaterialsRef.current).forEach((mat) => mat.dispose())
        toolMaterialsRef.current = null
      }
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }

  return cleanup
  }, [])

  useEffect(() => {
    if (modelUrl) {
      loadModelRef.current(modelUrl)
    }
  }, [modelUrl])

  useEffect(() => {
    clearToolpathGroup()
    if (!toolpathMode || !toolpathLayers.length) return
    const scene = sceneRef.current
    const mats = toolMaterialsRef.current
    if (!scene || !mats) return
    const safeIndex = Math.max(0, Math.min(toolLayerIndex, toolpathLayers.length - 1))
    const layer = toolpathLayers[safeIndex]
    if (!layer) return
    const group = new THREE.Group()
    for (const seg of layer.segments) {
      if (!toolVisibility[seg.kind]) continue
      if (!seg.positions || seg.positions.length === 0) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(seg.positions, 3))
      group.add(new THREE.LineSegments(geometry, mats[seg.kind]))
    }
    scene.add(group)
    toolpathGroupRef.current = group
    return () => {
      clearToolpathGroup()
    }
  }, [toolpathLayers, toolpathMode, toolLayerIndex, toolVisibility, clearToolpathGroup])

  // Auto-open size slider the first time a model appears
  useEffect(() => {
    console.debug('[Stage] hasModel changed', hasModel)
    if (hasModel) {
      setSizeOpen(true)
    }
  }, [hasModel])

  useEffect(() => {
    console.debug('[Stage] modelUrl state', modelUrl)
  }, [modelUrl])

  type SizedAssetOutcome =
    | { status: 'ready'; url: string }
    | { status: 'fallback'; url?: string }
    | { status: 'unauthorized' }
    | { status: 'missing'; message?: string }
    | { status: 'timeout' }
    | { status: 'error'; message?: string; error?: any }

  const ensureSizedAssetReady = useCallback(async (
    targetLongest: number,
    options: { filename?: string } = {},
  ): Promise<SizedAssetOutcome> => {
    if (!orderId) return { status: 'error', message: 'order_missing' }
    const filename = options.filename || 'print-ready-sized.stl'
    const desiredLongest = clampLongest(targetLongest)
    try {
      const committed = await commitSizeIfNeeded(desiredLongest)
      if (!committed) {
        return { status: 'error', message: 'size_commit_failed' }
      }
    } catch (error) {
      console.warn('[Stage] commitSizeIfNeeded failed', error)
      return { status: 'error', error }
    }
    try {
      const exportRes = await authFetch(`/api/orders/${orderId}/export-stl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_max_dim_mm: desiredLongest })
      })
      if (exportRes.status === 409) {
        const info = await exportRes.json().catch(() => null)
        return { status: 'missing', message: info?.message }
      }
      if (!exportRes.ok) {
        return { status: 'error', message: `export_failed:${exportRes.status}` }
      }

      const targetParam = Number.isFinite(desiredLongest) ? `&target_mm=${encodeURIComponent(desiredLongest.toFixed(2))}` : ''
      const targetTolParam = targetParam ? '&target_tol_mm=0.75' : ''
      const pollEndpoint = `/api/orders/${orderId}/download?kind=repaired_sized_stl&filename=${encodeURIComponent(filename)}&wait=1&format=json${targetParam}${targetTolParam}&max_wait_ms=240000&poll_interval_ms=1500`
      const fallbackEndpoint = `/api/orders/${orderId}/download?kind=repaired_stl&filename=${encodeURIComponent('print-ready.stl')}&wait=0&format=json`
      const deadline = Date.now() + 5 * 60 * 1000
      let attempt = 0
      let lastError: any = null
      while (Date.now() < deadline) {
        const downloadRes = await authFetch(pollEndpoint, { cache: 'no-store' })
        const contentType = downloadRes.headers.get('content-type') || ''
        const expectsJson = contentType.includes('application/json')

        if (downloadRes.ok) {
          const payload = expectsJson ? await downloadRes.json().catch(() => null) : null
          const signed = payload?.url
          if (signed) {
            return { status: 'ready', url: signed }
          }
          lastError = new Error('missing_download_url')
          break
        }

        if (downloadRes.status === 401) {
          return { status: 'unauthorized' }
        }

        if (downloadRes.status === 202) {
          let retryDelayMs = Math.min(5000, 1200 + attempt * 400)
          attempt += 1
          if (expectsJson) {
            const payload = await downloadRes.json().catch(() => null)
            const retryAfter = Number(payload?.retry_after)
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
              retryDelayMs = Math.max(1000, Math.min(10000, retryAfter * 1000))
            }
          }
          setNotice('Preparing print‑ready STL…')
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
          continue
        }

        if (expectsJson) {
          await downloadRes.json().catch(() => null)
        }
        lastError = new Error(`unexpected_status:${downloadRes.status}`)
        break
      }

      const fallbackRes = await authFetch(fallbackEndpoint).catch(() => null)
      if (fallbackRes && fallbackRes.ok && !userSizedRef.current) {
        const payload = await fallbackRes.json().catch(() => null)
        const signed = payload?.url
        if (signed) {
          return { status: 'fallback', url: signed }
        }
      }
      if (userSizedRef.current) {
        return { status: 'timeout' }
      }
      if (lastError && String(lastError?.message || '').includes('not_authenticated')) {
        return { status: 'unauthorized' }
      }
      return { status: 'timeout' }
    } catch (error: any) {
      if (String(error?.message || '').includes('not_authenticated')) {
        return { status: 'unauthorized' }
      }
      console.warn('[Stage] ensureSizedAssetReady failed', error)
      return { status: 'error', error }
    }
  }, [orderId, authFetch, clampLongest, commitSizeIfNeeded])

  const exportAndDownloadSized = useCallback(async (filename = 'print-ready-sized.stl') => {
    if (!orderId) return
    if (sizePendingExport) {
      setNotice('Sized STL already preparing — wait for Atom to finish before downloading.')
      return
    }
    const dlWin = typeof window !== 'undefined' ? window.open('', '_blank') : null
    try {
      setPreparingStl(true)
      setNotice('Preparing print‑ready STL…')
      const hasToken = await ensureTokenOrNotice()
      if (!hasToken) {
        dlWin?.close()
        return
      }
      notifyAtom('Starting the printable export — repairing the mesh before packaging the STL.')
      const desiredLongest = clampLongest(displayLongest)
      const outcome = await ensureSizedAssetReady(desiredLongest, { filename })
      const redirectHelper = () => {
        if (!dlWin) return
        try {
          dlWin.close()
        } catch {}
        if (!dlWin.closed) {
          try {
            dlWin.location.replace(window.location.origin)
          } catch {}
        }
      }
      if (outcome.status === 'ready' && outcome.url) {
        if (dlWin) {
          try { dlWin.location.href = outcome.url } catch {}
          setTimeout(redirectHelper, 1500)
        } else {
          const aEl = document.createElement('a')
          aEl.href = outcome.url
          aEl.download = filename
          document.body.appendChild(aEl)
          aEl.click(); aEl.remove()
        }
        setNotice(null)
        return
      }
      if (outcome.status === 'fallback' && outcome.url && !userSizedRef.current) {
        if (dlWin) {
          try { dlWin.location.href = outcome.url } catch {}
          setTimeout(redirectHelper, 1500)
        } else {
          const aEl = document.createElement('a')
          aEl.href = outcome.url
          aEl.download = 'print-ready.stl'
          document.body.appendChild(aEl)
          aEl.click(); aEl.remove()
        }
        setNotice('Sized export still preparing — downloaded repaired STL instead.')
        return
      }
      dlWin?.close()
      if (outcome.status === 'missing') {
        setNotice(outcome.message || 'No repaired STL available yet — try again once the mesh is stabilized.')
        return
      }
      if (outcome.status === 'unauthorized') {
        setNotice('Sign in to download print-ready files.')
        return
      }
      if (outcome.status === 'timeout') {
        if (userSizedRef.current) {
          setNotice('Sized STL still preparing. Keep this tab open or retry in a moment.')
        } else {
          setNotice('Download not ready yet — please retry in a moment.')
        }
        return
      }
      setNotice('Failed to prepare STL. Please retry.')
    } catch (error: any) {
      console.warn('[Stage] export download failed', error)
      dlWin?.close()
      if (String(error?.message || '').includes('not_authenticated')) {
        setNotice('Sign in to download print-ready files.')
      } else {
        setNotice('Failed to prepare STL. Please retry.')
      }
    } finally {
      setPreparingStl(false)
    }
  }, [orderId, ensureTokenOrNotice, clampLongest, displayLongest, ensureSizedAssetReady, sizePendingExport])

  const handleAddToStore = useCallback(async () => {
    if (!orderId || !hasModel || addingToStore) return
    try {
      setAddingToStore(true)
      setNotice('Preparing catalog asset…')
      const hasToken = await ensureTokenOrNotice()
      if (!hasToken) {
        setNotice('Sign in to add products to your store.')
        return
      }
      notifyAtom('Getting this ready for the storefront — Atom is repairing and exporting the mesh now.')
      const desiredLongest = clampLongest(displayLongest)
      const outcome = await ensureSizedAssetReady(desiredLongest)
      if (outcome.status === 'ready') {
        const previewDataUrl = captureViewerPreview()
        const payload: Record<string, any> = { target_max_dim_mm: desiredLongest }
        if (previewDataUrl) payload.preview_data_url = previewDataUrl
        const res = await authFetch(`/api/orders/${orderId}/store`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (res.ok) {
          const data = await res.json().catch(() => null)
          setNotice('Added to catalog.')
          if (data?.productId) {
            console.debug('[Stage] product created', data.productId)
          }
          return
        }
        const errorPayload = await res.json().catch(() => null)
        if (res.status === 202 && errorPayload?.status === 'pending_export') {
          setNotice(errorPayload?.message || 'Sizing the STL for your catalog — retry shortly.')
          return
        }
        if (res.status === 409) {
          setNotice(errorPayload?.message || 'No repaired STL available yet — wait for stabilization.')
          return
        }
        if (res.status === 401) {
          setNotice('Sign in to add products to your store.')
          return
        }
        setNotice(errorPayload?.error || 'Failed to add to store. Please retry.')
        return
      }
      if (outcome.status === 'missing') {
        setNotice(outcome.message || 'No repaired STL available yet — wait for stabilization.')
        return
      }
      if (outcome.status === 'timeout') {
        setNotice('Sized STL is still preparing. Keep this tab open and retry shortly.')
        return
      }
      if (outcome.status === 'unauthorized') {
        setNotice('Sign in to add products to your store.')
        return
      }
      setNotice('Failed to prepare sized STL — please retry.')
    } catch (error: any) {
      console.warn('[Stage] add-to-store failed', error)
      if (String(error?.message || '').includes('not_authenticated')) {
        setNotice('Sign in to add products to your store.')
      } else {
        setNotice('Failed to add to store. Please retry.')
      }
    } finally {
      setAddingToStore(false)
    }
  }, [orderId, hasModel, addingToStore, ensureTokenOrNotice, clampLongest, displayLongest, ensureSizedAssetReady, captureViewerPreview, authFetch])

  async function handleDownloadStl() {
    try {
      if (!hasModel) return
      const obj = objectRef.current
      if (!obj) return
      // Always export from the in‑memory scene so current sizing/orientation is honored,
      // even when the source asset is already an STL.
      const limitX = Math.max(1, BUILD_VOLUME_X_MM - 2)
      const limitY = Math.max(1, BUILD_VOLUME_Y_MM - 2)
      const limitZ = Math.max(1, BUILD_VOLUME_Z_MM - 2)
      const box = new THREE.Box3().setFromObject(obj)
      const size = box.getSize(new THREE.Vector3())
      const sx = limitX / Math.max(1e-6, size.x)
      const sy = limitY / Math.max(1e-6, size.y)
      const sz = limitZ / Math.max(1e-6, size.z)
      const s = Math.min(1, sx, sy, sz)
      const origScale = obj.scale.clone()
      if (s < 1) {
        obj.scale.multiplyScalar(s)
        obj.updateMatrixWorld(true)
      }
      const exporter = new STLExporter()
      const data = exporter.parse(obj, { binary: true }) as ArrayBuffer
      const blob = new Blob([data], { type: 'model/stl' })
      const dl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = dl
      a.download = 'model.stl'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(dl), 1500)
      // Restore original scale after export
      obj.scale.copy(origScale)
      obj.updateMatrixWorld(true)
    } catch {}
  }

  // Live preview: scale the displayed object to target longest-side mm using base dimensions
  useEffect(() => {
    applyTargetScale()
  }, [applyTargetScale])

  // Simple reset and wireframe toggles
  function handleReset() {
    try { stlAbortRef.current?.abort() } catch {}
    stlAbortRef.current = null
    clearAwaitingTransform()
    clearPendingExport()
    clearSceneRef.current?.()
    setHasModel(false)
    setModelUrl(null)
    setModelExt(null)
    modelUrlRef.current = null
    baseScaleRef.current = null
    baseMaxDimRef.current = null
    setPrintReadyUrl(null)
    currentAssetIdRef.current = null
    currentAssetKeyRef.current = null
    currentAssetCreatedAtRef.current = null
    currentKindRef.current = null
    currentAssetInfoRef.current = null
    setToolpathLayers([])
    setToolpathMode(false)
    setToolpathAsset(null)
    toolpathBBoxRef.current = null
    currentToolpathAssetIdRef.current = null
    setToolpathError(null)
    setToolpathLoading(false)
    setToolLayerIndex(0)
    setToolVisibility({ perimeter: true, infill: true, support: true })
    userSizedRef.current = false
    transformInFlightRef.current = false
    transformPromiseRef.current = null
    pendingTransformTargetRef.current = null
    committedLongestRef.current = null
    workerLongestRef.current = null
    stopSizingInteraction()
    setDisplayLongest(DEFAULT_LONGEST)
    persistSliderValue(null)
    pendingInitialPlacementRef.current = false
    setSavingSize(false)
    setWaitingForMesh(false)
    setOrderStatus(null)
    setNotice(null)
    setPreparingStl(false)
    setOrientationMeta(null)
    orientationMetaKeyRef.current = null
    setSliceMeta(null)
    sliceMetaKeyRef.current = null
    setSizeOpen(false)
    setReadyLongest(null)
    setPendingLongest(null)
    setSizeStatus('clean')
    setMeshExpectation(false)
    if (controlsRef.current && cameraRef.current) {
      const camera = cameraRef.current
      const controls = controlsRef.current
      const maxDim = Math.max(BUILD_VOLUME_X_MM, BUILD_VOLUME_Z_MM)
      const dist = (maxDim / Math.tan((camera.fov * Math.PI) / 360)) * 1.2
      const defaultDir = new THREE.Vector3(1, 0.9, 1).normalize()
      const currentOffset = cameraOffsetRef.current
      const hasPriorOffset = currentOffset && currentOffset.lengthSq() > 1e-8
      const priorDir = hasPriorOffset ? currentOffset!.clone().normalize() : defaultDir
      const targetY = BUILD_VOLUME_Y_MM * 0.3125
      controls.target.set(0, targetY, 0)
      const offset = priorDir.clone().multiplyScalar(dist)
      camera.position.copy(controls.target.clone().add(offset))
      if (!cameraOffsetRef.current) cameraOffsetRef.current = offset.clone()
      else cameraOffsetRef.current.copy(offset)
      camera.near = Math.max(0.1, dist / 500)
      camera.far = dist * 500
      camera.updateProjectionMatrix()
      controls.update()
    }
    onResetWorkspace?.(orderId || null)
  }
  function handleToggleWire() {
    if (materialRef.current) {
      materialRef.current.wireframe = !materialRef.current.wireframe
    }
  }

  async function onGetQuote() {
    if (!orderId) return
    try {
      const hasToken = await ensureTokenOrNotice()
      if (!hasToken) return
      // Ensure latest size is committed before slicing
      const committed = await commitSizeIfNeeded()
      if (!committed) {
        setNotice('Failed to queue slicing. Please retry.')
        return
      }
      await authFetch(`/api/orders/${orderId}/fabricate`, { method: 'POST' })
    } catch (err: any) {
      if (!String(err?.message || '').includes('not_authenticated')) {
        setNotice('Failed to queue slicing. Please try again.')
      }
    }
  }

  // Drag & Drop: immediate local preview + background upload (if orderId)
  function dragIntent(e: React.DragEvent): ModelDragIntent {
    try {
      return resolveModelDragIntent(e.dataTransfer ?? null)
    } catch {
      return 'maybe'
    }
  }
  function onDragEnter(e: React.DragEvent) {
    const intent = dragIntent(e)
    if (intent === 'no') {
      setIsDragging(false)
      return
    }
    e.preventDefault()
    setIsDragging(true)
  }
  function onDragOver(e: React.DragEvent) {
    const intent = dragIntent(e)
    if (intent === 'no') {
      setIsDragging(false)
      return
    }
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
    if (!isDragging) setIsDragging(true)
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    setIsDragging(false)
  }
  async function onDrop(e: React.DragEvent) {
    const intent = dragIntent(e)
    if (intent === 'no') {
      setIsDragging(false)
      return
    }
    e.preventDefault()
    setIsDragging(false)
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    const file = Array.from(files).find((entry) => isModelFileLike(entry))
    if (!file) return
    try {
      const url = URL.createObjectURL(file)
      setModelUrl(url)
      const name = (file.name || '').toLowerCase()
      const ext = name.endsWith('.stl') ? 'stl' : name.endsWith('.obj') ? 'obj' : name.endsWith('.glb') ? 'glb' : name.endsWith('.gltf') ? 'gltf' : null
      setModelExt(ext)
    } catch {}
    if (orderId) {
      try {
        const fd = new FormData()
        fd.append('file', file)
        const hasToken = await ensureTokenOrNotice()
        if (!hasToken) return
        await authFetch(`/api/orders/${orderId}/upload`, { method: 'POST', body: fd })
      } catch (err: any) {
        if (!String(err?.message || '').includes('not_authenticated')) {
          setNotice('Upload failed. Please retry.')
        }
      }
    }
  }

  const exportJobProcessing = activeExportJobStatus === 'pending' || activeExportJobStatus === 'processing'
  const exportJobFailed = activeExportJobStatus === 'failed'
  const exportJobSucceeded = activeExportJobStatus === 'succeeded'
  // Baseline ready size from the last printable STL we have (or the last size committed to server)
  const baselineReadyLongest = (readyLongest != null
    ? readyLongest
    : (committedLongestRef.current != null
        ? committedLongestRef.current
        : workerLongestRef.current)) as number | null
  const hasDrift = baselineReadyLongest != null && Math.abs((baselineReadyLongest as number) - displayLongest) >= 0.5

  // Sizing should only be available after the print check truly completes (slice OK).
  // Consider OK when Bambu slice passed (sliceMeta.status === 'ok'), a toolpath exists, or order is ready_to_pay.
  const toolpathPresent = Boolean(toolpathAsset && toolpathAsset.url)
  const initialPrintCheckOk = (sliceMeta?.status === 'ok') || toolpathPresent || (orderStatus === 'ready_to_pay')
  // Only unlock sizing after the initial print check completes
  const sizingAvailable = initialPrintCheckOk
  const sizeControlsDisabled = (!sizingAvailable) || sizingLatch || exportJobProcessing
  const hasSliceFailure = sliceMeta?.status === 'failed'
  const showSizeAction = sizingAvailable && hasPrintableBase && (hasDrift || sizeStatus !== 'clean' || hasSliceFailure || pendingNeedsStl)
  const sizeActionDisabled = !sizingAvailable || !hasPrintableBase || sizeStatus === 'processing' || exportJobProcessing
  // Show retry when: has repaired STL, not currently processing, and (slice failed OR not priced yet)
  const isPriced = (orderStatus === 'ready_to_pay')
  const canRetryPrintCheck = hasPrintableBase && !exportJobProcessing && (hasSliceFailure || !isPriced)
  const sizeActionLabel = (sizeStatus === 'processing' || exportJobProcessing) ? 'Repairing…' : 'Prepare new size STL'
  // Always render purchase actions when a model is present; gate clickability instead of visibility.
  const readyToPay = (orderStatus === 'ready_to_pay')
  const showPurchaseActions = hasModel && !exportJobProcessing
  const buyDisabled = !readyToPay || savingSize || exportJobProcessing || pendingNeedsStl || hasDrift || sizeStatus !== 'clean' || (sliceMeta?.status === 'failed')
  const addDisabled = !hasModel || addingToStore || buyDisabled
  const statusLongest = (() => {
    if (sizingLatch || exportJobProcessing) {
      return pendingLongest ?? displayLongest
    }
    if (pendingNeedsStl) {
      return pendingLongest ?? displayLongest
    }
    if (hasDrift) {
      return pendingLongest ?? displayLongest
    }
    if (sizeStatus === 'processing') {
      return pendingLongest ?? displayLongest
    }
    if (sizeStatus === 'clean' && !exportJobProcessing) {
      return readyLongest ?? displayLongest
    }
    return hasModel ? displayLongest : null
  })()
  const formattedStatusLongest = statusLongest != null ? formatMM(statusLongest) : null
  let sizeStatusMessage: string | null = null
  let sizeStatusClass = ''
  if (hasModel) {
    // While initial print check is not finished, always show an amber guidance message
    if (!sizingAvailable) {
      sizeStatusMessage = 'Print check running — please wait for results.'
      sizeStatusClass = 'bg-warning/15 text-warning'
    } else if (sizingLatch || exportJobProcessing) {
      sizeStatusMessage = formattedStatusLongest
        ? `Preparing printable STL for ${formattedStatusLongest} mm…`
        : 'Preparing printable STL…'
      sizeStatusClass = 'bg-warning/15 text-warning'
    } else if (pendingNeedsStl || hasDrift) {
      sizeStatusMessage = formattedStatusLongest
        ? `Resize pending — prepare ${formattedStatusLongest} mm STL to print.`
        : 'Resize pending — prepare a new STL to print.'
      sizeStatusClass = 'bg-warning/15 text-warning'
    } else if (sliceMeta?.status === 'failed' || exportJobFailed) {
      sizeStatusMessage = `Print check failed: ${sliceMeta.error || sliceMeta.message || 'See worker log.'}`
      sizeStatusClass = 'bg-warning/15 text-warning'
    } else if (sizeStatus === 'clean' && !exportJobProcessing) {
      const parts: string[] = []
      if (formattedStatusLongest) parts.push(`${formattedStatusLongest} mm`)
      if (sliceMeta?.status === 'ok') {
        parts.push(renderMinutes(sliceMeta))
        parts.push(renderGrams(sliceMeta))
      }
      // Declare "passed" only once the order is priced and ready.
      const pricedAndReady = (orderStatus === 'ready_to_pay')
      if (pricedAndReady) {
        sizeStatusMessage = parts.length ? `Print check passed — ${parts.join(' · ')}.` : 'Print check passed — ready to fabricate.'
        sizeStatusClass = 'bg-teal/15 text-teal'
      } else {
        sizeStatusMessage = 'Print check running — please wait for results.'
        sizeStatusClass = 'bg-warning/15 text-warning'
      }
    } else if (sizeStatus === 'processing') {
      sizeStatusMessage = formattedStatusLongest
        ? `Repairing mesh for ${formattedStatusLongest} mm…`
        : 'Repairing mesh for the requested size…'
      sizeStatusClass = 'bg-warning/15 text-warning'
    } else {
      sizeStatusMessage = formattedStatusLongest
        ? `Pending new printable STL for ${formattedStatusLongest} mm.`
        : 'Pending new printable STL.'
      sizeStatusClass = 'bg-warning/15 text-warning'
    }
  }

  const handleRequestPrintable = useCallback(async () => {
    if (!orderId) {
      setNotice((prev) => prev || 'Create an order before preparing print-ready files.')
      return
    }
    if (!showSizeAction) return
    if (sizeStatus === 'processing') return
    const target = clampLongest(pendingLongest != null ? pendingLongest : displayLongest)
    const ok = await commitSizeIfNeeded(target)
    if (!ok) {
      setNotice((prev) => prev || 'Failed to queue size repair. Please retry.')
      return
    }
    // Mark pending BEFORE calling the API to avoid a race where
    // the poller snaps back to the previous printable size.
    setSizingLocked(true)
    setSizeStatus('processing')
    setNotice('Preparing print‑ready STL…')
    // Clear any stale printable URL while a new sized STL is being prepared
    setPrintReadyUrl(null)
    pendingExportTargetRef.current = target
    pendingExportRequestedAtRef.current = Date.now()
    setPendingSize(true)
    try {
      const res = await authFetch(`/api/orders/${orderId}/export-stl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_max_dim_mm: target })
      })
      const info = await res.json().catch(() => null)
      if (!res.ok) {
        const code = (info?.error || info?.code || '').toString()
        const message = info?.message || 'Failed to queue size repair. Please retry.'
        clearPendingExport()
        setSizeStatus('dirty')
        const normalizedMessage = message.toLowerCase()
        const stabilizing409 = res.status === 409 && (code === 'no_repaired_stl' || normalizedMessage.includes('no repaired stl'))
        if (stabilizing409) {
          setNotice('Still stabilizing the mesh — try again once the STL finishes repairing.')
        } else {
          setNotice(message)
        }
      } else {
        const statusText = String(info?.status || '').toLowerCase()
        const jobId = info?.jobId ? String(info.jobId) : null
        if (jobId) {
          activeExportJobIdRef.current = jobId
        }
        // Reset any prior retry hint; we have a fresh job enqueued now.
        setExportRetryHint(false)
        // If the API reports an immediate succeeded (reused) job, keep the latch
        // and wait for the sized asset to actually attach via SSE/poll before
        // flipping to clean. Use asset_id (if present) to accept only the intended asset.
        // Adoption paths will clear latch and set clean.
        if (statusText === 'succeeded') {
          setActiveExportJobStatus('succeeded')
          const aid = info?.assetId ? String(info.assetId) : null
          if (aid) expectedSizedAssetIdRef.current = aid
          return
        }
        // keep pending state; job result will clear it
        if (statusText) {
          setActiveExportJobStatus(statusText)
        }
      }
    } catch (err: any) {
      console.warn('[Stage] export-stl enqueue failed', err)
      clearPendingExport()
      setSizeStatus('dirty')
      setNotice('Failed to queue size repair. Please retry.')
    }
  }, [orderId, showSizeAction, sizeStatus, clampLongest, pendingLongest, displayLongest, commitSizeIfNeeded, authFetch, setSizeStatus, clearPendingExport, setPendingSize, applyWorkerLongest])

  const handleRetrySlice = useCallback(async () => {
    if (!orderId) return
    try {
      setNotice('Re-running print check…')
      const res = await authFetch(`/api/orders/${orderId}/slice`, { method: 'POST' })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        setNotice(txt || 'Failed to start print check. Please retry.')
        return
      }
      // The poller will detect status changes; keep notice concise.
    } catch (err: any) {
      if (!String(err?.message || '').includes('not_authenticated')) {
        setNotice('Failed to start print check. Please retry.')
      }
    }
  }, [orderId, authFetch])

  // Allow the user to manually retry if the worker didn't pick up the job promptly.
  const handleExportRetry = useCallback(async () => {
    if (!orderId) return
    if (exportRetryInFlightRef.current) return
    exportRetryInFlightRef.current = true
    try {
      // Best-effort cancel current pending/processing job so re-enqueue is clean.
      try { await authFetch(`/api/orders/${orderId}/export-cancel`, { method: 'POST' }) } catch {}
      // Clear local job trackers and immediately re-enqueue using the current target.
      pendingExportRequestedAtRef.current = null
      pendingExportTargetRef.current = null
      activeExportJobIdRef.current = null
      setActiveExportJobStatus(null)
      setNotice('Retrying sized STL…')
      await handleRequestPrintable()
    } finally {
      exportRetryInFlightRef.current = false
    }
  }, [orderId, authFetch, handleRequestPrintable])

const showViewerSpinner = !hasModel && Boolean(expectsMesh)
  const viewerSpinnerTitle = waitingForMesh ? 'Materializing…' : 'Loading 3D model…'
  const viewerSpinnerSubtitle = waitingForMesh ? 'Generating mesh…' : 'Retrieving your mesh…'

  // Allow browser refresh to cancel a pending sized export and return the viewer to an editable state
  useEffect(() => {
    if (typeof window === 'undefined') return
    const nav = (performance.getEntriesByType('navigation') || [])[0] as any
    const isReload = nav ? String(nav.type) === 'reload' : ((performance as any).navigation?.type === 1)
    if (!isReload) return
    const wasPending = sizeStatusRef.current === 'processing' || pendingExportRequestedAtRef.current != null || ['pending','processing'].includes((lastExportJobStatusRef.current || '').toLowerCase())
    if (!wasPending) return
    (async () => {
      try {
        if (orderId) {
          // Best-effort cancel server-side jobs so UI and backend stay consistent
          await authFetch(`/api/orders/${orderId}/export-cancel`, { method: 'POST' })
        }
      } catch {}
      // Clear local pending state so the viewer is editable on reload
      pendingExportRequestedAtRef.current = null
      pendingExportTargetRef.current = null
      activeExportJobIdRef.current = null
      expectedSizedAssetIdRef.current = null
      setActiveExportJobStatus(null)
      setPendingSize(false)
      setPendingNeedsStl(false)
      setSizeStatus('dirty')
      setNotice(null)
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId])

  // If user has resized away from the last ready STL, prevent stale downloads
  // by clearing any previously cached print-ready URL until a new one is generated.
  useEffect(() => {
    if (hasDrift && printReadyUrl) {
      setPrintReadyUrl(null)
    }
  }, [hasDrift])

  return (
    <section
      className={`panel relative flex h-full min-h-[480px] w-full min-w-0 items-center justify-center overflow-hidden ${isDragging ? 'ring-2 ring-teal/60' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Decorative overlays should not intercept drag/drop */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(46,230,214,0.06),transparent_60%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[0.08]" style={{ backgroundImage: 'linear-gradient(transparent 95%, rgba(255,255,255,0.08) 95%)', backgroundSize: '100% 3px' }} />
      <div className="scan-sweep pointer-events-none absolute inset-0" />
      <ViewerControls
        onReset={handleReset}
        onToggleWire={handleToggleWire}
        onUpright={async () => {
          uprightRef.current()
          if (orderId) {
            try {
              const hasToken = await ensureTokenOrNotice()
              if (!hasToken) return
              await authFetch(`/api/orders/${orderId}/transform`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upright: true, target_max_dim_mm: clampLongest(displayLongest) })
              })
            } catch (err: any) {
              if (!String(err?.message || '').includes('not_authenticated')) {
                setNotice('Failed to store orientation. Please retry.')
              }
            }
          }
        }}
        onRotateX={() => rotateAndSeatRef.current('x', 1)}
        onRotateY={() => rotateAndSeatRef.current('y', 1)}
        onRotateZ={() => rotateAndSeatRef.current('z', 1)}
        onShare={async (a) => {
          if (a === 'print_stl') {
            if (baselineReadyLongest != null && Math.abs(baselineReadyLongest - displayLongest) >= 0.5) {
              setNotice('Resize pending — prepare a new STL for the current size before downloading.')
              return
            }
            if (sizePendingExport) {
              setNotice('Sized STL updating — wait for the new size to finish before downloading.')
              return
            }
            if (!printReadyUrl && !canPrepareStl) {
              setNotice('Repair still running — wait for Atom to finish stabilizing the mesh before exporting.')
              return
            }
            if (printReadyUrl) {
              // Direct download path: navigate a newly opened window synchronously to avoid blockers
              const dlWin = typeof window !== 'undefined' ? window.open('', '_blank') : null
              if (dlWin) dlWin.location.href = printReadyUrl
              else {
                const aEl = document.createElement('a')
                aEl.href = printReadyUrl
                aEl.download = 'print-ready.stl'
                document.body.appendChild(aEl)
                aEl.click(); aEl.remove()
              }
            } else {
              if (!orderId) { setNotice('Create an order first (send a prompt or upload a file).'); return }
              // Fallback: request a sized, repaired STL and download when ready
              await exportAndDownloadSized('print-ready.stl')
            }
            return
          }
          if (a === 'print_stl_sized') {
            if (sizePendingExport) {
              setNotice('Sized STL updating — wait for the new size to finish before downloading.')
              return
            }
            await exportAndDownloadSized('print-ready-sized.stl')
            return
          }
          if (a === 'stl') { handleDownloadStl(); return }
          if (a === 'original') {
            if (!modelUrl) return
            const aEl = document.createElement('a')
            aEl.href = modelUrl
            aEl.download = `model.${(modelExt || 'bin')}`
            document.body.appendChild(aEl)
            aEl.click(); aEl.remove();
            return
          }
          if (a === 'copy') {
            if (!modelUrl) return
            try { navigator.clipboard?.writeText(modelUrl) } catch {}
            return
          }
          if (a === 'share') {
            if (typeof navigator !== 'undefined' && (navigator as any).share && modelUrl) {
              try { (navigator as any).share({ title: '3D model', text: 'Check out this 3D model', url: modelUrl }) } catch {}
            } else if (modelUrl) {
              try { navigator.clipboard?.writeText(modelUrl) } catch {}
            }
            return
          }
        }}
        sourceExt={modelExt}
        hasPrintReady={!!printReadyUrl && !sizePendingExport && !hasDrift && !sizingLatch && !exportJobProcessing}
        disabledShare={!modelUrl || modelUrl.startsWith('blob:') || hasDrift}
        preparing={preparingStl || sizingLatch || exportJobProcessing}
        onManualDownload={orderId && !hasDrift ? () => exportAndDownloadSized('print-ready.stl') : undefined}
        canExportViewer={hasModel && !hasDrift}
        canPrepareStl={sizingAvailable && canPrepareStl && !hasDrift}
      />
      <div className="relative h-full w-full">
        <div ref={mountRef} className="h-full w-full" />
        {orderId && hasModel && (
          <div
            className="pointer-events-auto absolute bottom-14 right-4 w-[260px] rounded-md border border-white/10 bg-black/60 p-3 backdrop-blur"
            style={{ display: sizeOpen ? 'block' : 'none', maxWidth: 'min(260px, calc(100% - 32px))' }}
          >
            {readyLongest != null && (
              <button
                type="button"
                aria-label="Revert to ready size"
                onClick={handleRevertSize}
                disabled={sizeStatus === 'processing'}
                title="Revert to ready size"
                className="absolute left-3 top-3 flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/5 text-textMuted transition hover:bg-white/10 hover:text-textPrimary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5">
                  <path d="M6.5 6.5h-3v-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 6.5a6 6 0 1 1-1.2 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <div className="mb-2 flex items-center justify-between text-xs text-textMuted pl-8">
              <div className="flex items-center gap-2">
                <span>Longest side</span>
                {sizingActive && <span className="rounded-full bg-teal/20 px-2 py-0.5 text-[10px] uppercase tracking-wide text-teal">Preview</span>}
              </div>
              <div className="tabular-nums text-textPrimary">{Math.round(displayLongest)} mm</div>
            </div>
            <input
              aria-label="Size (mm)"
              type="range"
              min={20}
              max={sizeLimitMax}
              step={1}
              value={displayLongest}
              onChange={(e) => handleDisplayChange(Number(e.target.value))}
              onPointerDown={beginSizingInteraction}
              onPointerUp={() => handleSliderPointerUp()}
              onPointerCancel={() => handleSliderPointerUp()}
              className="w-full"
              disabled={sizeControlsDisabled}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => handleDisplayChange(Math.round(displayLongest) - 5, { immediate: true })} className="rounded bg-white/5 px-2 py-1 text-xs disabled:opacity-60" disabled={sizeControlsDisabled}>-5</button>
              <button onClick={() => handleDisplayChange(Math.round(displayLongest) + 5, { immediate: true })} className="rounded bg-white/5 px-2 py-1 text-xs disabled:opacity-60" disabled={sizeControlsDisabled}>+5</button>
              <button onClick={() => handleDisplayChange(60, { immediate: true })} className="rounded bg-white/5 px-2 py-1 text-xs disabled:opacity-60" disabled={sizeControlsDisabled}>60</button>
              <button onClick={() => handleDisplayChange(100, { immediate: true })} className="rounded bg-white/5 px-2 py-1 text-xs disabled:opacity-60" disabled={sizeControlsDisabled}>100</button>
              <button onClick={() => handleDisplayChange(sizeLimitMax, { immediate: true })} className="rounded bg-white/5 px-2 py-1 text-xs disabled:opacity-60" disabled={sizeControlsDisabled}>Max</button>
            </div>
            {sizeStatusMessage && (
              <div className={`mt-3 rounded px-2 py-1 text-[11px] ${sizeStatusClass}`}>
                {sizeStatusMessage}
              </div>
            )}
            {canRetryPrintCheck && (
              <button
                type="button"
                onClick={handleRetrySlice}
                className="mt-2 w-full rounded border border-white/20 px-3 py-1.5 text-sm text-textPrimary hover:bg-white/10 disabled:opacity-60"
                disabled={exportJobProcessing}
              >
                Retry print check
              </button>
            )}
            {showSizeAction && (
              <button
                type="button"
                onClick={handleRequestPrintable}
                className="mt-3 w-full rounded border border-teal/60 px-3 py-1.5 text-sm text-teal hover:bg-teal/10 disabled:opacity-60 disabled:hover:bg-transparent"
                disabled={sizeActionDisabled}
              >
                {sizeActionLabel}
              </button>
            )}
            {showPurchaseActions && (
              <>
                <button
                  type="button"
                  onClick={() => setBuyOpen(true)}
                  className="mt-3 w-full rounded bg-teal px-3 py-1.5 text-sm text-black disabled:opacity-60"
                  disabled={buyDisabled}
                  title={buyDisabled ? 'Print check running or size pending — payment unlocks when priced.' : 'Proceed to purchase'}
                >
                  Buy now
                </button>
                <button
                  onClick={handleAddToStore}
                  className="mt-2 w-full rounded border border-white/20 px-3 py-1.5 text-sm text-textPrimary hover:bg-white/10 disabled:opacity-60 disabled:hover:bg-transparent"
                  disabled={addDisabled}
                  title={addDisabled ? 'Available after print check and baseline are ready.' : 'Add to your storefront'}
                >
                  {addingToStore ? 'Adding…' : 'Add to store'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {toolpathLayers.length > 0 && (
        <div className="pointer-events-auto absolute top-4 right-4 flex gap-2 rounded-full border border-white/10 bg-black/60 px-2 py-1 text-xs backdrop-blur">
          <button
            type="button"
            className={`rounded-full px-3 py-1 ${!toolpathMode ? 'bg-teal text-black' : 'text-textPrimary hover:bg-white/10'}`}
            onClick={() => {
              setToolpathMode(false)
              setToolpathError(null)
            }}
          >
            Mesh
          </button>
          <button
            type="button"
            className={`rounded-full px-3 py-1 ${toolpathMode ? 'bg-teal text-black' : 'text-textPrimary hover:bg-white/10'}`}
            onClick={() => {
              if (toolpathLayers.length === 0) return
              setToolpathMode(true)
              setToolpathError(null)
            }}
          >
            Toolpath
          </button>
        </div>
      )}
      {toolpathMode && toolpathLayers.length > 0 && (
        <div className="pointer-events-auto absolute top-16 right-4 w-[260px] rounded-md border border-white/10 bg-black/60 p-3 text-xs text-textPrimary backdrop-blur">
          <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-textMuted">
            <span>Layer</span>
            <span className="tabular-nums text-textPrimary">{toolLayerIndex + 1} / {toolpathLayers.length}</span>
          </div>
          <input
            aria-label="Toolpath layer"
            type="range"
            min={0}
            max={Math.max(toolpathLayers.length - 1, 0)}
            value={toolLayerIndex}
            onChange={(e) => setToolLayerIndex(Number(e.target.value))}
            className="mt-2 w-full"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {(['perimeter','infill','support'] as FeatureKind[]).map((kind) => {
              const active = toolVisibility[kind]
              return (
                <button
                  key={kind}
                  type="button"
                  className={`rounded-full px-2 py-1 text-[11px] ${active ? 'bg-white/15 text-textPrimary' : 'bg-white/5 text-textMuted'}`}
                  onClick={() => setToolVisibility((prev) => ({ ...prev, [kind]: !prev[kind] }))}
                >
                  {kind === 'perimeter' ? 'Perimeter' : kind === 'infill' ? 'Infill' : 'Support'}
                </button>
              )
            })}
          </div>
        </div>
      )}
      {toolpathLoading && (
        <div className="pointer-events-none absolute top-16 right-4 rounded-md border border-white/10 bg-black/70 px-3 py-1.5 text-xs text-textPrimary">
          Parsing toolpath…
        </div>
      )}
      {toolpathError && (
        <div className="pointer-events-auto absolute top-28 right-4 max-w-[260px] rounded-md border border-warning/40 bg-black/70 px-3 py-1.5 text-xs text-warning">
          {toolpathError}
        </div>
      )}
      {hasModel && (sizingLatch || exportJobProcessing) && (
        <div className="pointer-events-none absolute top-16 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-black/70 px-4 py-1.5 text-sm text-textPrimary shadow-lg">
          Preparing sized STL…
        </div>
      )}
      {hasModel && (sizingLatch || exportJobProcessing) && exportRetryHint && (
        <div className="pointer-events-auto absolute top-24 left-1/2 z-20 -translate-x-1/2 rounded-full border border-white/10 bg-black/80 px-3 py-1 text-[12px] text-textPrimary shadow-lg">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded px-2 py-0.5 text-textPrimary hover:text-teal"
            onClick={handleExportRetry}
            title="Retry preparing the sized STL"
          >
            Having trouble? Retry now
          </button>
        </div>
      )}
      {/* Toggle pill */}
      {orderId && sizingAvailable && (
        <button onClick={() => setSizeOpen((v) => !v)} className="pointer-events-auto absolute bottom-14 left-4 rounded-full border border-white/10 bg-black/60 px-3 py-1 text-xs text-textPrimary">
          {sizeOpen ? 'Hide Size' : 'Size'}
        </button>
      )}
      {orderId && hasModel && !sizingAvailable && (
        <div className="pointer-events-none absolute bottom-14 left-4 rounded-full border border-white/10 bg-black/60 px-3 py-1 text-[11px] text-warning">
          Print check running — sizing unlocks soon
        </div>
      )}
      {orderId && buyOpen && (
        <BuyModal open={buyOpen} orderId={orderId} sizeMm={baselineReadyLongest ?? null} onClose={() => setBuyOpen(false)} />
      )}
      {!hasModel && (
        previewOverlayUrl ? (
          <div className="pointer-events-none absolute inset-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewOverlayUrl} alt="Mesh preview" className="h-full w-full object-contain opacity-90" />
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            {showViewerSpinner ? (
              <>
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
                <div className="mt-3 text-sm text-textPrimary">{viewerSpinnerTitle}</div>
                <div className="mt-1 text-xs text-textMuted/70">{viewerSpinnerSubtitle}</div>
              </>
            ) : (
              <>
                <div className="text-textMuted">3D Viewer</div>
                <div className="mt-1 text-xs text-textMuted/70">Drop STL/OBJ/GLB to preview + upload</div>
              </>
            )}
          </div>
        )
      )}
      <div className="absolute bottom-0 left-0 right-0 border-t border-white/5 bg-black/30 px-4 py-2 text-xs text-textMuted">
        Watertight • No Self-Intersections • Units: mm • Min Wall ≥ 1.6mm • Fits Build Volume
      </div>
      {notice && (
        <div className="pointer-events-none absolute bottom-4 right-4 rounded-md bg-black/70 px-3 py-1.5 text-xs text-textPrimary border border-white/10">
          {notice}
        </div>
      )}
    </section>
  )
}
