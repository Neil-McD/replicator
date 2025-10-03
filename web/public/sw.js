/* Replicator Service Worker — project capsules (stale-while-revalidate)
 * Caches content-addressed artifacts under /api/artifacts/:sha and serves fast from cache.
 */
const ARTIFACT_CACHE = 'replicator-artifacts-v1'
const OPFS_DIR = 'replicator-artifacts'
const OPFS_MIN_BYTES = 1_000_000 // store to OPFS when ≥ 1MB

async function getOPFSRoot() {
  try {
    // @ts-ignore
    const root = await self.navigator.storage.getDirectory()
    return root
  } catch (e) {
    return null
  }
}

async function opfsGetHandles(sha) {
  const root = await getOPFSRoot()
  if (!root) return { dir: null, file: null, meta: null }
  let dir
  try {
    dir = await root.getDirectoryHandle(OPFS_DIR, { create: true })
  } catch {
    return { dir: null, file: null, meta: null }
  }
  let file = null
  let meta = null
  try { file = await dir.getFileHandle(sha, { create: false }) } catch {}
  try { meta = await dir.getFileHandle(`${sha}.meta`, { create: false }) } catch {}
  return { dir, file, meta }
}

async function opfsRead(sha) {
  try {
    const { dir, file, meta } = await opfsGetHandles(sha)
    if (!file) return null
    const f = await file.getFile()
    let headers = new Headers({ 'ETag': sha, 'Cache-Control': 'public, max-age=31536000, immutable, stale-while-revalidate=86400' })
    if (meta) {
      try {
        const mf = await meta.getFile(); const text = await mf.text(); const j = JSON.parse(text)
        if (j && j.contentType) headers.set('Content-Type', j.contentType)
        if (j && typeof j.size === 'number') headers.set('Content-Length', String(j.size))
        // Update lastAccess time
        try {
          const mh = await dir.getFileHandle(`${sha}.meta`, { create: true })
          const mw = await mh.createWritable()
          j.lastAccess = Date.now()
          await mw.write(JSON.stringify(j))
          await mw.close()
        } catch {}
      } catch {}
    }
    return new Response(await f.arrayBuffer(), { headers })
  } catch {
    return null
  }
}

async function opfsWrite(sha, response) {
  try {
    const { dir } = await opfsGetHandles(sha)
    if (!dir) return false
    const buf = await response.arrayBuffer()
    if (buf.byteLength < OPFS_MIN_BYTES) return false
    const fh = await dir.getFileHandle(sha, { create: true })
    const ws = await fh.createWritable()
    await ws.write(buf)
    await ws.close()
    try {
      const mh = await dir.getFileHandle(`${sha}.meta`, { create: true })
      const mw = await mh.createWritable()
      const meta = { contentType: response.headers.get('content-type') || null, size: buf.byteLength, lastAccess: Date.now() }
      await mw.write(JSON.stringify(meta))
      await mw.close()
    } catch {}
    // Prune if needed
    try { await opfsPruneIfNeeded(dir) } catch {}
    return true
  } catch {
    return false
  }
}

const MAX_OPFS_BYTES = 250 * 1024 * 1024 // ~250MB budget
async function opfsPruneIfNeeded(dirHandle) {
  try {
    // Build inventory from .meta files
    const items = []
    // @ts-ignore
    for await (const [name, handle] of dirHandle.entries()) {
      if (typeof name === 'string' && name.endsWith('.meta')) {
        try {
          const f = await handle.getFile()
          const text = await f.text()
          const j = JSON.parse(text)
          const sha = name.replace(/\.meta$/, '')
          const size = Number(j?.size || 0)
          const at = Number(j?.lastAccess || 0)
          items.push({ sha, size, at })
        } catch {}
      }
    }
    const total = items.reduce((s, it) => s + (it.size || 0), 0)
    if (total <= MAX_OPFS_BYTES) return
    items.sort((a, b) => (a.at || 0) - (b.at || 0))
    let bytes = total
    for (const it of items) {
      if (bytes <= MAX_OPFS_BYTES) break
      try { await dirHandle.removeEntry(it.sha).catch(()=>{}) } catch {}
      try { await dirHandle.removeEntry(`${it.sha}.meta`).catch(()=>{}) } catch {}
      bytes -= it.size || 0
    }
  } catch {}
}

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

async function cachePut(request, response) {
  try {
    const cache = await caches.open(ARTIFACT_CACHE)
    await cache.put(request, response)
  } catch (err) {
    // ignore cache errors
  }
}

async function cacheMatch(request) {
  try {
    const cache = await caches.open(ARTIFACT_CACHE)
    const hit = await cache.match(request)
    return hit || null
  } catch {
    return null
  }
}

function isArtifactRequest(url) {
  try {
    const u = typeof url === 'string' ? new URL(url, self.location.origin) : new URL(url)
    return u.pathname.startsWith('/api/artifacts/')
  } catch {
    return false
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (!isArtifactRequest(req.url)) return
  event.respondWith((async () => {
    // Try OPFS by sha first
    let sha = null
    try { sha = new URL(req.url).pathname.split('/').pop() } catch {}
    if (sha) {
      const local = await opfsRead(sha)
      if (local) {
        // Async revalidate in background
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(req, { cache: 'reload' })
            if (fresh && fresh.ok) {
              await cachePut(req, fresh.clone())
              await opfsWrite(sha, fresh.clone())
            }
          } catch {}
        })())
        return local
      }
    }
    const cached = await cacheMatch(req)
    if (cached) {
      // Revalidate in background
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(req, { cache: 'reload' })
          if (fresh && fresh.ok) {
            await cachePut(req, fresh.clone())
            if (sha) await opfsWrite(sha, fresh.clone())
          }
        } catch {}
      })())
      return cached
    }
    try {
      const res = await fetch(req)
      if (res && res.ok) {
        await cachePut(req, res.clone())
        if (sha) await opfsWrite(sha, res.clone())
      }
      return res
    } catch (err) {
      if (cached) return cached
      throw err
    }
  })())
})

self.addEventListener('message', (event) => {
  const data = event.data || {}
  if (data && data.type === 'HYDRATE_ORDER' && Array.isArray(data.assets)) {
    // Best-effort prefetch of artifact URLs
    const unique = new Set()
    const list = data.assets
      .map((a) => (typeof a?.url === 'string' ? a.url : null))
      .filter((u) => (u && isArtifactRequest(u) ? u : null))
    for (const u of list) unique.add(u)
    event.waitUntil(
      (async () => {
        for (const u of unique) {
          try {
            const req = new Request(u, { method: 'GET' })
            const existing = await cacheMatch(req)
            if (!existing) {
              const res = await fetch(req, { cache: 'reload' })
              if (res && res.ok) await cachePut(req, res.clone())
            }
          } catch {}
        }
        // Signal back that we’re warm
        try {
          event.source?.postMessage?.({ type: 'ORDER_READY', orderId: data.orderId || null })
        } catch {}
      })()
    )
  }
})
