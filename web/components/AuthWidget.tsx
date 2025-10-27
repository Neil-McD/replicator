"use client"
import { useEffect, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabaseClient'

export default function AuthWidget({ onAuth }: { onAuth?: (userId: string | null) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'oauth' | 'magic' | 'password'>('oauth')
  const [loading, setLoading] = useState(false)
  const [userId, setUserId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const ALLOW_EMAIL = (process.env.NEXT_PUBLIC_ALLOW_EMAIL_SIGNIN ?? '1').toString().toLowerCase() !== '0' &&
    (process.env.NEXT_PUBLIC_ALLOW_EMAIL_SIGNIN ?? '1').toString().toLowerCase() !== 'false'

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

  async function signInWithGoogle() {
    setLoading(true); setMsg(null)
    try {
      const { error } = await supabaseBrowser.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: typeof window !== 'undefined'
            ? `${window.location.origin}/auth/callback`
            : undefined
        }
      })
      if (error) throw error
      // Redirect happens automatically, no need to update state
    } catch (e: any) {
      setMsg(e?.message || 'Google sign-in failed')
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {!userId ? (
        <>
          {/* Primary: Google OAuth */}
          {mode === 'oauth' && (
            <>
              <button
                onClick={signInWithGoogle}
                disabled={loading}
                className="w-full rounded-mdx border border-white/10 bg-white px-4 py-3 text-sm font-semibold text-black transition-all hover:bg-white/90 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-center justify-center gap-3">
                  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                    <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
                    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
                    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
                    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
                  </svg>
                  {loading ? 'Please wait...' : 'Continue with Google'}
                </div>
              </button>

              {/* Optional: Email link beneath Google button */}
              {ALLOW_EMAIL && (
                <div className="mt-3 text-center">
                  <button
                    type="button"
                    onClick={() => setMode('magic')}
                    className="text-xs text-textMuted transition-colors hover:text-textPrimary"
                  >
                    Sign in with email instead →
                  </button>
                </div>
              )}

          {ALLOW_EMAIL && (
            <>
              <div className="relative flex items-center gap-3 text-xs text-textMuted">
                <div className="flex-1 border-t border-white/10" />
                <span>or</span>
                <div className="flex-1 border-t border-white/10" />
              </div>
              <button
                onClick={() => setMode('magic')}
                type="button"
                className="w-full text-center text-xs text-textMuted transition-colors hover:text-tealGlow"
              >
                Continue with email instead →
              </button>
            </>
          )}
            </>
          )}

          {/* Magic link mode */}
          {ALLOW_EMAIL && mode === 'magic' && (
            <>
              <div>
                <input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && email) {
                      void signInOtp()
                    }
                  }}
                  className="w-full rounded-mdx border border-white/10 bg-black/20 px-4 py-3 text-sm text-textPrimary placeholder-textMuted/60 transition-colors focus:border-tealGlow focus:outline-none focus:ring-2 focus:ring-tealGlow/30"
                  autoFocus
                />
              </div>

              <button
                onClick={signInOtp}
                disabled={loading || !email}
                className="w-full rounded-mdx bg-white text-black px-4 py-3 text-sm font-semibold transition-all hover:bg-white/90 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Please wait...' : 'Continue with email'}
              </button>

              {/* Back to OAuth */}
              <button
                onClick={() => setMode('oauth')}
                type="button"
                className="w-full text-center text-xs text-textMuted transition-colors hover:text-tealGlow"
              >
                ← Back to Google sign in
              </button>
            </>
          )}

          {/* Password mode (hidden by default, accessible via advanced link) */}
          {ALLOW_EMAIL && mode === 'password' && (
            <>
              <div>
                <input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full rounded-mdx border border-white/10 bg-black/20 px-4 py-3 text-sm text-textPrimary placeholder-textMuted/60 transition-colors focus:border-tealGlow focus:outline-none focus:ring-2 focus:ring-tealGlow/30"
                  autoFocus
                />
              </div>

              <div>
                <input
                  type="password"
                  placeholder="Password (6+ characters)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && email && password) {
                      void signInPassword()
                    }
                  }}
                  className="w-full rounded-mdx border border-white/10 bg-black/20 px-4 py-3 text-sm text-textPrimary placeholder-textMuted/60 transition-colors focus:border-tealGlow focus:outline-none focus:ring-2 focus:ring-tealGlow/30"
                />
              </div>

              <button
                onClick={signUpPassword}
                disabled={loading || !email || !password}
                className="w-full rounded-mdx bg-white text-black px-4 py-3 text-sm font-semibold transition-all hover:bg-white/90 hover:shadow-[0_0_20px_rgba(255,255,255,0.2)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Please wait...' : 'Create account'}
              </button>

              <div className="flex items-center justify-between text-xs">
                <button
                  onClick={signInPassword}
                  disabled={loading || !email || !password}
                  className="text-textMuted transition-colors hover:text-textPrimary disabled:opacity-50"
                >
                  Already have an account? Sign in
                </button>
                <button
                  onClick={() => setMode('oauth')}
                  type="button"
                  className="text-textMuted transition-colors hover:text-tealGlow"
                >
                  ← Back
                </button>
              </div>
            </>
          )}

          {/* Status message */}
          {msg && (
            <div className={`rounded-mdx border px-3 py-2 text-xs ${
              msg.includes('Check your email')
                ? 'border-tealGlow/20 bg-tealGlow/10 text-tealGlow'
                : 'border-danger/20 bg-danger/10 text-danger'
            }`}>
              {msg}
            </div>
          )}
        </>
      ) : (
        <div className="flex items-center justify-between rounded-mdx border border-white/10 bg-black/20 px-4 py-3">
          <div className="text-sm text-textMuted">Signed in</div>
          <button
            onClick={signOut}
            disabled={loading}
            className="text-xs text-textMuted transition-colors hover:text-textPrimary disabled:opacity-50"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  )
}
