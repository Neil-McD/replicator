"use client"
import { useEffect, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabaseClient'

export default function AuthWidget({ onAuth }: { onAuth?: (userId: string | null) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'magic' | 'password'>('magic')
  const [loading, setLoading] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    supabaseBrowser.auth.getUser().then(({ data }) => {
      if (!mounted) return
      const u = data?.user || null
      setUserId(u?.id ?? null)
      onAuth?.(u?.id ?? null)
    })
    const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_e, session) => {
      const u = session?.user || null
      setUserId(u?.id ?? null)
      onAuth?.(u?.id ?? null)
    })
    return () => { mounted = false; sub.subscription.unsubscribe() }
  }, [onAuth])

  async function signInOtp() {
    setLoading(true); setMsg(null)
    try {
      let redirect = undefined as string | undefined
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.set('continue', 'synthesize')
        redirect = url.toString()
      }
      const { error } = await supabaseBrowser.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } })
      if (error) throw error
      setMsg('Check your email for a magic link.')
    } catch (e: any) {
      setMsg(e?.message || 'Sign-in failed')
    } finally {
      setLoading(false)
    }
  }

  async function signUpPassword() {
    setLoading(true); setMsg(null)
    try {
      const { error } = await supabaseBrowser.auth.signUp({ email, password })
      if (error) throw error
      setMsg('Account created. Check your email to confirm, then sign in.')
    } catch (e: any) {
      setMsg(e?.message || 'Sign-up failed')
    } finally {
      setLoading(false)
    }
  }

  async function signInPassword() {
    setLoading(true); setMsg(null)
    try {
      const { error } = await supabaseBrowser.auth.signInWithPassword({ email, password })
      if (error) throw error
      setMsg(null)
    } catch (e: any) {
      setMsg(e?.message || 'Sign-in failed')
    } finally {
      setLoading(false)
    }
  }

  async function signOut() {
    setLoading(true)
    try { await supabaseBrowser.auth.signOut() } finally { setLoading(false) }
  }

  return (
    <div className="panel p-3">
      {!userId ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs text-textMuted">
            <span>Account</span>
            <div className="ml-auto inline-flex rounded-mdx border border-white/10 p-0.5">
              <button
                className={`px-2 py-0.5 text-xs ${mode === 'magic' ? 'bg-white/10 text-textPrimary' : 'text-textMuted hover:bg-white/5'}`}
                onClick={() => setMode('magic')}
                type="button"
              >Magic link</button>
              <button
                className={`px-2 py-0.5 text-xs ${mode === 'password' ? 'bg-white/10 text-textPrimary' : 'text-textMuted hover:bg-white/5'}`}
                onClick={() => setMode('password')}
                type="button"
              >Password</button>
            </div>
          </div>
          <input
            type="email"
            placeholder="you@replicator.io"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-mdx border border-white/10 bg-black/20 p-2 text-sm text-textPrimary font-mono"
          />
          {mode === 'password' && (
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-mdx border border-white/10 bg-black/20 p-2 text-sm text-textPrimary"
            />
          )}
          {mode === 'magic' ? (
            <div className="flex items-center justify-between">
              <button
                onClick={signInOtp}
                disabled={loading || !email}
                className="rounded-mdx bg-teal px-3 py-2 text-sm font-medium text-black hover:brightness-110 disabled:opacity-50"
              >
                Sign up free
              </button>
              <button
                onClick={() => setMode('password')}
                type="button"
                className="text-xs text-teal underline"
              >Use password instead</button>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={signUpPassword}
                  disabled={loading || !email || !password}
                  className="rounded-mdx bg-teal px-3 py-2 text-sm font-medium text-black hover:brightness-110 disabled:opacity-50"
                >Sign up free</button>
                <button
                  onClick={signInPassword}
                  disabled={loading || !email || !password}
                  className="rounded-mdx border border-white/10 px-3 py-2 text-sm text-textPrimary hover:bg-white/5 disabled:opacity-50"
                >Sign in</button>
              </div>
              <button onClick={() => setMode('magic')} className="text-xs text-teal underline" type="button">Use magic link</button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between text-xs">
          <div className="text-textMuted">Signed in</div>
          <button onClick={signOut} disabled={loading} className="rounded-mdx border border-white/10 px-2 py-1 hover:bg-white/5">Sign out</button>
        </div>
      )}
      {msg && <div className="mt-2 text-xs text-textMuted">{msg}</div>}
    </div>
  )
}
