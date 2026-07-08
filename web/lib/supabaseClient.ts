import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let browserClient: SupabaseClient | null = null

function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    if (typeof window === 'undefined') {
      return createClient('http://127.0.0.1:54321', 'build-placeholder-anon-key', {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      })
    }
    throw new Error('Supabase browser env is not configured')
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
}

export function getSupabaseBrowser() {
  if (!browserClient) browserClient = createSupabaseBrowserClient()
  return browserClient
}

export const supabaseBrowser = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client: any = getSupabaseBrowser()
    const value = client[prop]
    return typeof value === 'function' ? value.bind(client) : value
  },
})
