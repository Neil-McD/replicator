import { createClient } from '@supabase/supabase-js'

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!url || !serviceKey) throw new Error('Supabase env vars missing')
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
  })
}

export function parseSupabaseUrl(u: string): { bucket: string; path: string } | null {
  // Format: supabase://<bucket>/<path>
  try {
    if (!u.startsWith('supabase://')) return null
    const rest = u.replace('supabase://', '')
    const [bucket, ...parts] = rest.split('/')
    return { bucket, path: parts.join('/') }
  } catch {
    return null
  }
}

export function normalizeSupabaseUrl(u: string | null | undefined): string | null {
  if (!u || typeof u !== 'string') return null
  if (u.startsWith('supabase://')) return u
  try {
    const url = new URL(u)
    const parts = url.pathname.split('/').filter(Boolean)
    const objectIdx = parts.indexOf('object')
    if (objectIdx === -1) return null
    let bucketIdx = objectIdx + 1
    // Skip action segment (sign/public/download)
    if (['sign', 'public', 'download'].includes(parts[bucketIdx])) {
      bucketIdx += 1
    }
    const bucket = decodeURIComponent(parts[bucketIdx] || '')
    const keyParts = parts
      .slice(bucketIdx + 1)
      .map((segment) => decodeURIComponent(segment || ''))
      .filter((segment) => segment.length > 0)
    if (!bucket || keyParts.length === 0) return null
    return `supabase://${bucket}/${keyParts.join('/')}`
  } catch {
    return null
  }
}

export type SignedUrlInfo = {
  url: string
  expiresAt?: number | null
  fromSupabase: boolean
  bucket?: string | null
  path?: string | null
}

export async function signedUrlOrDirect(url: string, expiresIn = 3600): Promise<string> {
  const info = await signedUrlWithInfo(url, expiresIn)
  return info.url
}

export async function signedUrlWithInfo(url: string, expiresIn = 3600): Promise<SignedUrlInfo> {
  const parsed = parseSupabaseUrl(url)
  if (!parsed) {
    return { url, expiresAt: null, fromSupabase: false }
  }
  const client = createAdminClient()
  const { data, error } = await client.storage.from(parsed.bucket).createSignedUrl(parsed.path, expiresIn)
  if (error) throw error
  let signed = data.signedUrl
  // Hint browsers to download instead of previewing by adding the `download` param
  // for known printable artifacts. This also provides a filename.
  try {
    const lower = parsed.path.toLowerCase()
    const isStl = lower.endsWith('.stl')
    const is3mf = lower.endsWith('.3mf')
    if (isStl || is3mf) {
      const baseName = parsed.path.split('/').pop() || (isStl ? 'model.stl' : 'model.3mf')
      const u = new URL(signed)
      // If a download param is already present, leave it; otherwise add one.
      if (!u.searchParams.has('download')) u.searchParams.set('download', baseName)
      signed = u.toString()
    }
  } catch {}
  return {
    url: signed,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
    fromSupabase: true,
    bucket: parsed.bucket,
    path: parsed.path,
  }
}

export async function ensureStorageBucket(name: string) {
  const client = createAdminClient()
  // getBucket is supported in supabase-js v2; fall back to list if needed
  const got = await client.storage.getBucket(name)
  if (!got.error && got.data) return true
  // If not found, try to create
  const created = await client.storage.createBucket(name, { public: false })
  if (created.error) throw created.error
  return true
}
