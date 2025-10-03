import { ensureStorageBucket } from '@/lib/supabaseAdmin'
import { robustImageFetch } from '@/lib/httpFetch'

/**
 * Mirror a remote image to Supabase Storage and return a supabase:// URL.
 * Falls back to the original URL on failure.
 */
export async function mirrorRemoteImageToStorage(
  supabase: any,
  sourceUrl: string,
  opts: { bucket: string; prefix: string }
): Promise<string> {
  const { bucket, prefix } = opts
  try {
    await ensureStorageBucket(bucket)
  } catch {}
  try {
    const fetched = await robustImageFetch(sourceUrl)
    const b = Buffer.from(fetched.ab)
    const ct = (fetched.contentType || 'image/jpeg').toLowerCase()
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg'
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const path = `${prefix}/${name}`
    const up = await supabase.storage.from(bucket).upload(path, b, { upsert: true, contentType: ct })
    if (up.error) throw up.error
    return `supabase://${bucket}/${path}`
  } catch {
    // Best effort: fall back to the original URL so callers can still proceed
    return sourceUrl
  }
}
