"use client"
import AuthWidget from '@/components/AuthWidget'

export default function AuthModal({ open, onClose, onAuthenticated, title }: {
  open: boolean
  onClose?: () => void
  onAuthenticated?: (userId: string) => void
  title?: string
}) {
  if (!open) return null
  const heading = title || 'Unlock the Fabricator'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative z-10 w-[560px] overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0b]/95 shadow-2xl">
        <div className="flex items-start justify-between border-b border-white/10 bg-gradient-to-r from-teal/30 to-blue-500/10 px-6 py-5">
          <div>
            <h2 className="text-2xl font-semibold text-textPrimary">{heading}</h2>
            <p className="mt-1 text-base leading-7 text-textMuted">
              Create your free account to generate, preview, and print AI-powered 3D models.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-mdx border border-white/10 px-2.5 py-1 text-xs text-textMuted hover:bg-white/5"
            aria-label="Close"
          >
            Close
          </button>
        </div>
        <div className="px-6 pb-5 pt-4">
          <ul className="mb-4 grid grid-cols-1 gap-2 text-base text-textMuted">
            <li className="flex items-center gap-2">
              <span className="inline-block h-4 w-4 rounded-full bg-teal/30 text-[10px] text-teal flex items-center justify-center">✓</span>
              Generate instantly — Text → 3D mesh in seconds
            </li>
            <li className="flex items-center gap-2">
              <span className="inline-block h-4 w-4 rounded-full bg-teal/30 text-[10px] text-teal flex items-center justify-center">✓</span>
              See before you print — Interactive previews & accurate quotes
            </li>
            <li className="flex items-center gap-2">
              <span className="inline-block h-4 w-4 rounded-full bg-teal/30 text-[10px] text-teal flex items-center justify-center">✓</span>
              Own your process — Track jobs, pay securely, download anytime
            </li>
          </ul>
          
          <AuthWidget onAuth={(id) => { if (id) onAuthenticated?.(id) }} />
          <div className="mt-3 text-xs text-textMuted/80">
            By continuing, you agree to our acceptable use policy (no weapons/illegal/IP-infringing content).
          </div>
        </div>
      </div>
    </div>
  )
}
