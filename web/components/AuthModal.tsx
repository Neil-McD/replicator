"use client"
import AuthWidget from '@/components/AuthWidget'

export default function AuthModal({ open, onAuthenticated, title, onClose }: {
  open: boolean
  onAuthenticated?: (userId: string) => void
  title?: string
  onClose?: () => void
}) {
  if (!open) return null
  const heading = title || 'Sign in to start'
  const subtitle = 'Create your free account to generate, preview, and print AI‑powered 3D models.'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop (no click-to-close) */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

      {/* Neutral gray card; non-dismissable */}
      <div className="relative z-10 w-full max-w-[460px] overflow-hidden rounded-lgx border border-white/12 bg-neutral-900/95 shadow-modal">
        {/* Heading */}
        <div className="px-6 pt-6 pb-1">
          <h2 className="text-2xl font-semibold text-textPrimary">{heading}</h2>
          <p className="mt-2 text-sm leading-relaxed text-textMuted">{subtitle}</p>
        </div>

        {/* Auth form */}
        <div className="px-6 pb-6 pt-4">
          <AuthWidget onAuth={(id) => { if (id) onAuthenticated?.(id) }} />
        </div>

        {/* Footnote */}
        <div className="border-t border-white/5 bg-white/[0.02] px-6 py-3">
          <p className="text-xs text-textMuted/80">
            By continuing, you agree to our acceptable use policy.
          </p>
        </div>
      </div>
    </div>
  )
}
