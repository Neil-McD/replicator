import { createAdminClient, ensureStorageBucket, signedUrlOrDirect } from '@/lib/supabaseAdmin'
import crypto from 'crypto'

// Minimal, direct Image→3D generation to warm the viewer while the worker runs.

type QuickResult = { ext: 'stl'|'obj'|'glb'|'gltf', bytes: Uint8Array } | null
type QuickImageInput = { url: string; viewRole?: string | null }

async function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)) }

function yes(input?: string | null): boolean {
  if (!input) return false
  return ['1', 'true', 'yes', 'on'].includes(String(input).trim().toLowerCase())
}

const MESHY_ALLOWED_MODELS = new Set(['meshy-4','meshy-5','latest'])

function pickMeshyModel(envValue: string | undefined, fallback: string): string {
  if (!envValue) return fallback
  const trimmed = envValue.trim()
  if (MESHY_ALLOWED_MODELS.has(trimmed)) return trimmed
  console.warn(`[Meshy] invalid ai_model "${envValue}"; using "${fallback}" instead`)
  return fallback
}

function parseIntEnv(name: string): number | null {
  const raw = process.env[name]
  if (!raw) return null
  const num = Number(raw)
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : null
}

function pickFirstMeshUrl(modelUrls: Record<string, any> | undefined): { url: string; ext: 'stl'|'obj'|'glb'|'gltf' } | null {
  if (!modelUrls) return null
  for (const ext of ['stl', 'obj', 'glb', 'gltf'] as const) {
    const candidate = modelUrls?.[ext]
    if (typeof candidate === 'string' && candidate.startsWith('http')) {
      return { url: candidate, ext }
    }
  }
  return null
}

function pickUrlFromPayload(payload: any): { url: string; ext: 'stl'|'obj'|'glb'|'gltf' } | null {
  if (!payload) return null
  const urls: string[] = []
  const visit = (node: any) => {
    if (!node) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node === 'object') {
      const maybeUrl = node.url
      if (typeof maybeUrl === 'string' && maybeUrl.startsWith('http')) urls.push(maybeUrl)
      for (const value of Object.values(node)) visit(value)
    }
  }
  visit(payload)
  for (const ext of ['stl', 'obj', 'glb', 'gltf'] as const) {
    const hit = urls.find((u) => u.toLowerCase().endsWith(`.${ext}`))
    if (hit) return { url: hit, ext }
  }
  if (urls.length) return { url: urls[0], ext: 'glb' }
  return null
}

function intFromEnv(name: string): number | null {
  const raw = process.env[name]
  if (!raw) return null
  const num = Number(raw)
  return Number.isFinite(num) ? Math.floor(num) : null
}

const VIEW_ROLE_PRIORITY = ['front','back','left','right','top','bottom']

function normalizeViewRole(role?: string | null): string | null {
  if (!role) return null
  const norm = role.trim().toLowerCase()
  if (!norm) return null
  if (norm === 'opposite') return 'back'
  if (norm === 'rear') return 'back'
  if (norm === 'side') return 'right'
  return VIEW_ROLE_PRIORITY.includes(norm) ? norm : null
}

function orderInputs(inputs: QuickImageInput[]): QuickImageInput[] {
  if (inputs.length <= 1) return inputs
  const seen = new Set<string>()
  const prioritized: QuickImageInput[] = []
  for (const role of VIEW_ROLE_PRIORITY) {
    const hit = inputs.find((item) => normalizeViewRole(item.viewRole) === role)
    if (hit) {
      prioritized.push({ ...hit, viewRole: normalizeViewRole(hit.viewRole) || undefined })
      seen.add(hit.url)
    }
  }
  for (const item of inputs) {
    if (!seen.has(item.url)) {
      prioritized.push({ ...item, viewRole: normalizeViewRole(item.viewRole) || undefined })
    }
  }
  return prioritized
}

function buildTripoPayload(inputs: QuickImageInput[]): Record<string, any> {
  const ordered = orderInputs(inputs)
  const payload: Record<string, any> = {}
  if (!ordered.length) return payload
  if (ordered.length === 1) {
    payload.image_url = ordered[0].url
    return payload
  }
  const take = (role: 'front'|'back'|'left'|'right') => ordered.find((item) => normalizeViewRole(item.viewRole) === role)
  const assigned = {
    front: take('front') || ordered[0],
  }
  payload.front_image_url = assigned.front.url
  const remaining = ordered.filter((item) => item !== assigned.front)
  const fillSlot = (slot: 'back'|'left'|'right', fallbackList: QuickImageInput[]) => {
    const direct = ordered.find((item) => normalizeViewRole(item.viewRole) === slot)
    if (direct) {
      payload[`${slot}_image_url`] = direct.url
      return fallbackList.filter((i) => i !== direct)
    }
    if (fallbackList.length) {
      const next = fallbackList.shift()
      if (next) payload[`${slot}_image_url`] = next.url
      return fallbackList
    }
    return fallbackList
  }
  let pool = remaining.slice()
  pool = fillSlot('back', pool)
  pool = fillSlot('left', pool)
  pool = fillSlot('right', pool)
  return payload
}

export async function tripoQuickGenerate(images: QuickImageInput[], opts?: { timeoutS?: number }): Promise<QuickResult> {
  if (!images.length) return null
  const key = process.env.FAL_KEY || process.env.FAL_API_KEY
  if (!key) return null
  const base = (process.env.FAL_BASE_URL || 'https://fal.run').replace(/\/$/, '')
  const single = (process.env.TRIPO_ENDPOINT || 'tripo3d/tripo/v2.5/image-to-3d').replace(/^\//, '')
  const multi = (process.env.TRIPO_MULTI_ENDPOINT || 'tripo3d/tripo/v2.5/multiview-to-3d').replace(/^\//, '')
  const ordered = orderInputs(images)
  const useMulti = ordered.length > 1
  const endpoint = useMulti ? multi : single
  const url = `${base}/${endpoint}`
  const payload = buildTripoPayload(ordered)
  const maybeInt = (envName: string, field: string) => {
    const num = intFromEnv(envName)
    if (num !== null) payload[field] = num
  }
  const maybeStr = (envName: string, field: string) => {
    const v = process.env[envName]
    if (v) payload[field] = v
  }
  const maybeBool = (envName: string, field: string) => {
    if (Object.prototype.hasOwnProperty.call(process.env, envName)) payload[field] = yes(process.env[envName])
  }
  maybeInt('TRIPO_SEED', 'seed')
  maybeInt('TRIPO_TEXTURE_SEED', 'texture_seed')
  maybeInt('TRIPO_FACE_LIMIT', 'face_limit')
  maybeStr('TRIPO_TEXTURE', 'texture')
  maybeStr('TRIPO_TEXTURE_ALIGNMENT', 'texture_alignment')
  maybeStr('TRIPO_ORIENTATION', 'orientation')
  maybeStr('TRIPO_STYLE', 'style')
  maybeBool('TRIPO_PBR', 'pbr')
  maybeBool('TRIPO_AUTO_SIZE', 'auto_size')
  maybeBool('TRIPO_QUAD', 'quad')

  const headers: Record<string, string> = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }
  let body: any = null
  const timeoutS = Math.max(60, Number(opts?.timeoutS || process.env.TRIPO_TIMEOUT_S || process.env.FAST_MATERIALIZE_TIMEOUT_S || 300))

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) })
  if (res.ok) {
    try { body = await res.json() } catch { body = null }
  } else {
    return null
  }

  let candidate = pickUrlFromPayload(body)
  if (!candidate) {
    let pollUrl: string | null = null
    if (body && typeof body === 'object') {
      for (const keyName of ['response_url', 'status_url']) {
        const val = body[keyName]
        if (typeof val === 'string' && val.startsWith('http')) { pollUrl = val; break }
      }
      if (!pollUrl) {
        const rid = body.request_id || body.id || body.task_id
        if (typeof rid === 'string' && rid) pollUrl = `${url.replace(/\/$/, '')}/requests/${rid}`
      }
    }
    if (pollUrl) {
      const start = Date.now()
      while ((Date.now() - start) / 1000 < timeoutS) {
        const pr = await fetch(pollUrl, { headers: { Authorization: `Key ${key}` } })
        if (!pr.ok) {
          await sleep(2000)
          continue
        }
        let payloadJson: any = null
        try { payloadJson = await pr.json() } catch { payloadJson = null }
        candidate = pickUrlFromPayload(payloadJson)
        if (candidate) break
        const status = (payloadJson?.status || payloadJson?.state || '').toString().toLowerCase()
        if (['failed', 'canceled', 'cancelled', 'error'].includes(status)) return null
        await sleep(3000)
      }
    }
  }

  if (!candidate) return null
  const dl = await fetch(candidate.url)
  if (!dl.ok) return null
  const bytes = new Uint8Array(await dl.arrayBuffer())
  return { ext: candidate.ext, bytes }
}

export async function meshyQuickGenerate(images: QuickImageInput[], opts?: { fastTimeoutS?: number }): Promise<QuickResult> {
  if (!images.length) return null
  const key = process.env.MESHY_API_KEY
  if (!key) return null
  const base = (process.env.MESHY_API_BASE || 'https://api.meshy.ai').replace(/\/$/, '')
  const fastTimeoutS = Math.max(30, Number(opts?.fastTimeoutS || process.env.FAST_MATERIALIZE_TIMEOUT_S || 120))
  const headers: Record<string, string> = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }

  const ordered = orderInputs(images)
  const urlList = ordered.map((item) => item.url)
  const useMulti = urlList.length > 1 && !yes(process.env.MESHY_QUICK_SINGLE_IMAGE_ONLY || '')
  const primaryList = urlList.slice(0, Math.min(4, urlList.length))
  const singleModel = pickMeshyModel(process.env.MESHY_IMAGE_MODEL, 'latest')
  const multiFallback = singleModel === 'latest' ? 'meshy-5' : singleModel
  const multiModel = pickMeshyModel(process.env.MESHY_MULTI_MODEL, multiFallback)
  const payload: Record<string, any> = {
    topology: 'triangle',
    should_remesh: true,
    should_texture: false,
    enable_pbr: false,
    moderation: false,
    symmetry_mode: 'auto',
  }
  const targetPoly = parseIntEnv('MESHY_TARGET_POLYCOUNT')
  if (targetPoly && targetPoly >= 100) payload.target_polycount = targetPoly

  let createUrl: string
  let pollUrl: string
  if (useMulti) {
    payload.image_urls = primaryList
    payload.ai_model = multiModel
    createUrl = `${base}/openapi/v1/multi-image-to-3d`
    pollUrl = `${base}/openapi/v1/multi-image-to-3d/`
  } else {
    payload.image_url = primaryList[0]
    payload.ai_model = singleModel
    createUrl = `${base}/openapi/v1/image-to-3d`
    pollUrl = `${base}/openapi/v1/image-to-3d/`
  }

  const res = await fetch(createUrl, { method: 'POST', headers, body: JSON.stringify(payload) })
  if (!res.ok) return null
  let jd: any
  try { jd = await res.json() } catch { return null }
  const taskId = jd?.result || jd?.id
  if (!taskId) return null
  const pollEndpoint = `${pollUrl}${taskId}`

  const start = Date.now()
  while ((Date.now() - start) / 1000 < fastTimeoutS) {
    const pollRes = await fetch(pollEndpoint, { headers: { Authorization: `Bearer ${key}` } })
    if (!pollRes.ok) {
      if (pollRes.status >= 500) {
        await sleep(2000)
        continue
      }
      return null
    }
    let body: any = null
    try { body = await pollRes.json() } catch {}
    const status = body?.status || body?.task_status
    if (status === 'SUCCEEDED') {
      const picked = pickFirstMeshUrl(body?.model_urls)
      if (picked) {
        const dl = await fetch(picked.url)
        if (!dl.ok) return null
        const bytes = new Uint8Array(await dl.arrayBuffer())
        return { ext: picked.ext, bytes }
      }
      return null
    }
    if (status === 'FAILED' || status === 'CANCELED') return null
    await sleep(2500)
  }
  return null
}

function sha256(buf: Uint8Array): string {
  const h = crypto.createHash('sha256')
  h.update(Buffer.from(buf))
  return h.digest('hex')
}

export async function attachQuickMesh(orderId: string, sources: Array<{ assetUrl: string; viewRole?: string | null }> | string[]): Promise<{ kind: string; url: string } | null> {
  if (!sources.length) return null
  const normalized: { assetUrl: string; viewRole?: string | null }[] = []
  for (const entry of sources as any[]) {
    if (!entry) continue
    if (typeof entry === 'string') {
      normalized.push({ assetUrl: entry })
    } else if (typeof entry.assetUrl === 'string') {
      normalized.push({ assetUrl: entry.assetUrl, viewRole: entry.viewRole })
    }
  }
  if (!normalized.length) return null
  const signedInputs: QuickImageInput[] = []
  for (const item of normalized) {
    try {
      const signed = await signedUrlOrDirect(item.assetUrl)
      signedInputs.push({ url: signed, viewRole: item.viewRole })
    } catch {}
  }
  if (!signedInputs.length) return null
  // Meshy-only for quick preview (Tripo disabled)
  let res = await meshyQuickGenerate(signedInputs)
  if (!res) return null
  const supabase = createAdminClient()
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'artifacts'
  await ensureStorageBucket(bucket)
  const b = res.bytes
  const hexd = sha256(b)
  const path = `artifacts/${orderId}/${hexd}.${res.ext}`
  const contentType = res.ext === 'stl' ? 'model/stl' : res.ext === 'obj' ? 'model/obj' : res.ext === 'glb' ? 'model/gltf-binary' : 'model/gltf+json'
  const up = await supabase.storage.from(bucket).upload(path, Buffer.from(b), { upsert: true, contentType })
  if (up.error) return null
  const url = `supabase://${bucket}/${path}`
  const kind = `raw_${res.ext}`
  await supabase.from('assets').insert({ order_id: orderId, kind, url, sha256: hexd })
  // Light signal in chat to warm the UI; viewer will pick asset via polling/SSE
  await supabase.from('chat_messages').insert({ order_id: orderId, role: 'assistant', type: 'text', content_json: { text: 'Low-res preview generating…' } })
  return { kind, url }
}
