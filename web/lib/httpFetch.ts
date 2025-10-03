/**
 * Robust image fetch with retries, timeout and conservative headers.
 * Intended for mirroring third‑party provider URLs that may enforce
 * referer/UA checks or issue transient 403/5xx responses.
 */

export type RobustImageFetchResult = {
  ab: ArrayBuffer
  contentType: string
  status: number
  attempts: number
  usedReferer?: string | null
}

export type RobustImageFetchOptions = {
  timeoutMs?: number
  retries?: number
  backoffBaseMs?: number
  userAgent?: string
}

const DEFAULT_UA =
  process.env.MIRROR_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Fetches an image URL with retry and basic header variations.
 * - Attempts first with Accept:image/* and Referer derived from URL origin
 * - On 403/404/410, retries once toggling Referer/off
 * - Retries on 5xx/network with exponential backoff + jitter
 */
export async function robustImageFetch(
  url: string,
  opts: RobustImageFetchOptions = {},
): Promise<RobustImageFetchResult> {
  const timeoutMs = Math.max(1000, Number(process.env.MIRROR_TIMEOUT_MS || opts.timeoutMs || 10_000))
  const retries = Math.max(0, Number(process.env.MIRROR_RETRIES || opts.retries || 2))
  const backoffBaseMs = Math.max(50, Number(process.env.MIRROR_BACKOFF_BASE_MS || opts.backoffBaseMs || 450))
  const userAgent = opts.userAgent || DEFAULT_UA

  let lastErr: any = null
  let attempts = 0
  let usedReferer: string | null | undefined = undefined

  for (let i = 0; i <= retries; i++) {
    attempts = i + 1
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
      const u = new URL(url)
      // Toggle referer behavior: first try with origin; on 403-ish try again without.
      const tryWithoutReferer = i > 0 && usedReferer != null
      const headers: Record<string, string> = {
        Accept: 'image/avif,image/webp,image/apng,image/*;q=0.9,*/*;q=0.8',
        'User-Agent': userAgent,
      }
      if (!tryWithoutReferer) {
        const origin = u.origin || `${u.protocol}//${u.host}`
        headers.Referer = origin + '/'
        usedReferer = headers.Referer
      } else {
        usedReferer = null
      }
      const res = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        cache: 'no-store',
        signal: ac.signal,
      })
      clearTimeout(timer)
      if (!res.ok) {
        // For 403/404/410 let the loop retry with alternate headers or backoff
        lastErr = new Error(`http_${res.status}`)
        // If this was the final attempt, break by throwing below
      } else {
        const ct = (res.headers.get('content-type') || 'image/jpeg').toLowerCase()
        const ab = await res.arrayBuffer()
        return { ab, contentType: ct, status: res.status, attempts, usedReferer }
      }
    } catch (e: any) {
      clearTimeout(timer)
      lastErr = e
    }
    // Decide backoff before next attempt
    if (i < retries) {
      const jitter = Math.floor(Math.random() * 250)
      const backoff = Math.floor(backoffBaseMs * Math.pow(2, i)) + jitter
      await sleep(backoff)
    }
  }
  const msg = typeof lastErr?.message === 'string' ? lastErr.message : 'network_error'
  const err: any = new Error(`fetch_failed:${msg}`)
  err.attempts = attempts
  err.usedReferer = usedReferer
  throw err
}

