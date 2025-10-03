import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

let authClient: SupabaseClient | null = null

function getEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} env var missing`)
  return value
}

function ensureAuthClient(): SupabaseClient {
  if (!authClient) {
    const url = getEnv('NEXT_PUBLIC_SUPABASE_URL')
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
    if (!anon) throw new Error('Supabase anon key env var missing')
    authClient = createClient(url, anon, { auth: { persistSession: false } })
  }
  return authClient
}

function parseCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const [rawKey, ...rest] = part.trim().split('=')
    if (!rawKey || rawKey !== name) continue
    return rest.join('=') || null
  }
  return null
}

function extractBearer(req: Request): string | null {
  const header = req.headers.get('authorization') || req.headers.get('Authorization')
  if (header && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, '').trim() || null
  }
  const alt = req.headers.get('x-supabase-authorization') || req.headers.get('x-supabase-auth')
  if (alt) return alt.trim() || null
  const cookieToken = parseCookie(req.headers.get('cookie'), 'sb-access-token')
  if (cookieToken) return cookieToken.trim() || null
  return null
}

function isAdminUser(user: User | null | undefined): boolean {
  if (!user) return false
  const meta: any = user.app_metadata || {}
  const roles = meta.roles || meta.role
  if (Array.isArray(roles)) return roles.includes('admin')
  if (typeof roles === 'string') return roles === 'admin'
  if (meta.is_admin === true) return true
  return false
}

function getUserRoles(user: User | null | undefined): string[] {
  if (!user) return []
  const meta: any = user.app_metadata || {}
  const raw = meta.roles ?? meta.role ?? []
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list.map((r: any) => String(r || '').toLowerCase()).filter(Boolean)
}

function hasRole(user: User | null | undefined, role: string): boolean {
  const roles = getUserRoles(user)
  return roles.includes(String(role || '').toLowerCase())
}

function isOperatorUser(user: User | null | undefined): boolean {
  return hasRole(user, 'operator') || hasRole(user, 'print-operator')
}

export type AuthContext = { user: User; token: string; isAdmin: boolean; isOperator: boolean; roles: string[] }

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

export async function getAuthContextFromToken(token: string | null | undefined): Promise<AuthContext | null> {
  if (!token) return null
  const supabase = ensureAuthClient()
  let lastErr: any = null
  const delays = [200, 600]
  for (let attempt = 0; attempt < delays.length + 1; attempt++) {
    try {
      const { data, error } = await supabase.auth.getUser(token)
      if (error || !data?.user) {
        lastErr = error || new Error('no_user')
      } else {
        const roles = getUserRoles(data.user)
        return { user: data.user, token, isAdmin: isAdminUser(data.user), isOperator: isOperatorUser(data.user), roles }
      }
    } catch (e: any) {
      lastErr = e
    }
    if (attempt < delays.length) {
      await sleep(delays[attempt])
    }
  }
  // Fallback: locally decode JWT without verification (dev resilience; dev-only)
  try {
    if (process.env.NODE_ENV === 'production') return null
    const parts = token.split('.')
    if (parts.length === 3) {
      const payloadJson = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
      const nowSec = Math.floor(Date.now() / 1000)
      if (payloadJson && typeof payloadJson.sub === 'string' && (!payloadJson.exp || payloadJson.exp > nowSec - 5)) {
        const pseudoUser: any = {
          id: payloadJson.sub,
          email: payloadJson.email || null,
          role: 'authenticated',
          app_metadata: payloadJson.app_metadata || {},
          user_metadata: payloadJson.user_metadata || payloadJson.user_meta || {},
        }
        const roles = getUserRoles(pseudoUser)
        return { user: pseudoUser as User, token, isAdmin: isAdminUser(pseudoUser), isOperator: isOperatorUser(pseudoUser), roles }
      }
    }
  } catch {
    // ignore, fall through
  }
  // Soft-fail as unauthenticated when upstream is flaky and local decode failed
  return null
}

export async function getAuthContext(req: Request): Promise<AuthContext | null> {
  const token = extractBearer(req)
  return getAuthContextFromToken(token)
}

export async function requireAuthContext(req: Request): Promise<AuthContext> {
  const ctx = await getAuthContext(req)
  if (!ctx) {
    const err = new Error('not_authenticated')
    ;(err as any).statusCode = 401
    throw err
  }
  return ctx
}

export { getUserRoles, hasRole, isOperatorUser }
