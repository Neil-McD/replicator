"use client"

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { supabaseBrowser } from '@/lib/supabaseClient'
import { authedFetch } from '@/lib/clientAuth'
import * as namesOverlay from '@/lib/namesOverlay'

type LeftRailSession = {
  id: string
  prompt_text?: string | null
  status?: string | null
  created_at?: string | null
}

type LeftRailProps = {
  showOperator?: boolean
  onStartNew?: () => void
  expanded?: boolean
  sessions?: LeftRailSession[] | null
  activeSessionId?: string | null
  lastVisitedSessionId?: string | null
  onSessionSelect?: (orderId: string) => void
  onSessionHover?: (orderId: string) => void
  onRenamingChange?: (renaming: boolean) => void
}

const Item = ({
  href,
  label,
  icon,
  isNew,
  className,
}: {
  href: string
  label: string
  icon: React.ReactNode
  isNew?: boolean
  className?: string
}) => {
  const pathname = usePathname()
  const active = pathname === href
  return (
    <Link
      href={href}
      data-rail-nav="1"
      style={{ cursor: 'pointer' }}
      className={`focus-ring relative flex h-8 w-8 shrink-0 items-center justify-center rounded-mdx border border-white/5 transition-all duration-400 ease-in-out ${
        active ? 'bg-white/5 text-textPrimary' : isNew ? 'bg-white/10 text-teal hover:bg-white/15' : 'text-textMuted hover:bg-white/5'
      } ${isNew ? 'shadow-[0_0_18px_rgba(46,230,214,0.45)] transition-shadow duration-500' : ''} ${className ?? ''}`}
      aria-label={label}
      title={label}
    >
      {isNew && (
        <span className="pointer-events-none absolute -top-1 right-0 rounded-full bg-teal px-1 text-[8px] font-semibold uppercase text-black shadow-lg">
          New
        </span>
      )}
      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
        {icon}
      </span>
    </Link>
  )
}

function renderPrompt(prompt?: string | null) {
  if (!prompt) return 'Untitled fabrication'
  const trimmed = prompt.trim()
  if (!trimmed) return 'Untitled fabrication'
  return trimmed.length > 50 ? `${trimmed.slice(0, 47)}…` : trimmed
}

function formatTimestamp(input?: string | null) {
  if (!input) return ''
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = Date.now() - date.getTime()
  if (diffMs < 60_000) return 'Just now'
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m`
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h`
  return date.toLocaleDateString()
}

export default function LeftRail({
  showOperator,
  onStartNew,
  expanded = false,
  sessions,
  activeSessionId,
  lastVisitedSessionId,
  onSessionSelect,
  onSessionHover,
  onRenamingChange,
}: LeftRailProps) {
  const [isAuthed, setIsAuthed] = useState(false)
  const [profileInitial, setProfileInitial] = useState<string>('◎')
  const [profileEmail, setProfileEmail] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const sessionItems = sessions ?? []
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState<string>('')
  const [localNames, setLocalNames] = useState<Record<string, string>>({})
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())
  const [overlayNames, setOverlayNames] = useState<Record<string, string>>({})
  const bcRef = useRef<BroadcastChannel | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const widthClass = expanded ? 'w-[220px]' : 'w-[64px]'
  const navRowClass = 'flex w-full items-center transition-all duration-400 ease-in-out'
  const iconFrameClass = expanded
    ? 'flex w-[40px] items-center justify-start pl-[3px]'
    : 'flex w-[64px] items-center justify-start pl-[3px]'
  const iconCellClass = 'flex h-8 w-8 items-center justify-center rounded-mdx transition-all duration-400 ease-in-out'
  const labelBaseClass = 'flex-1 overflow-hidden text-sm font-medium text-textPrimary/85 transition-all duration-300 ease-out whitespace-nowrap'
  const labelStateClass = expanded ? 'ml-1 max-w-[160px] opacity-100' : 'ml-0 max-w-0 opacity-0'

  useEffect(() => {
    let mounted = true
    supabaseBrowser.auth
      .getUser()
      .then(({ data }) => {
        if (!mounted) return
        const user = data?.user
        if (user) {
          setIsAuthed(true)
          const email = user.email || null
          setProfileEmail(email)
          if (email && email.length > 0) setProfileInitial(email.charAt(0).toUpperCase())
          else if (user.user_metadata?.full_name) setProfileInitial(String(user.user_metadata.full_name).charAt(0).toUpperCase())
          else setProfileInitial('◎')
        } else {
          setIsAuthed(false)
          setProfileEmail(null)
          setProfileInitial('◎')
        }
      })
      .catch(() => {
        if (!mounted) return
        setIsAuthed(false)
        setProfileEmail(null)
        setProfileInitial('◎')
      })
    const { data: sub } = supabaseBrowser.auth.onAuthStateChange((_event, session) => {
      const user = session?.user
      if (user) {
        setIsAuthed(true)
        const email = user.email || null
        setProfileEmail(email)
        if (email && email.length > 0) setProfileInitial(email.charAt(0).toUpperCase())
        else if (user.user_metadata?.full_name) setProfileInitial(String(user.user_metadata.full_name).charAt(0).toUpperCase())
        else setProfileInitial('◎')
      } else {
        setIsAuthed(false)
        setProfileEmail(null)
        setProfileInitial('◎')
      }
    })
    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Load and subscribe to overlay names + BroadcastChannel
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data: { user } } = await supabaseBrowser.auth.getUser()
        const userId = user?.id
        if (!userId) return
        const all = namesOverlay.getAll(userId)
        if (!cancelled) {
          const map: Record<string, string> = {}
          for (const [k, v] of Object.entries(all)) map[k] = v.v
          setOverlayNames(map)
        }
        // BroadcastChannel for cross-tab updates
        try {
          const bc = new BroadcastChannel('replicator:orders')
          bcRef.current = bc
          bc.onmessage = (ev) => {
            const msg = ev.data || {}
            if (msg && msg.type === 'order.updated' && typeof msg.id === 'string') {
              const { id, title } = msg
              setOverlayNames((m) => ({ ...m, [id]: title }))
            }
          }
        } catch {}
      } catch {}
    })()
    return () => {
      cancelled = true
      try { bcRef.current?.close() } catch {}
    }
  }, [])

  // Close per-item menus when clicking outside
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-rail-item-menu]')) return
      if (target?.closest('[data-rail-item-kebab]')) return
      setMenuOpenId(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  async function renameOrder(id: string, name: string): Promise<boolean> {
    const next = name.trim().slice(0, 200)
    if (!next) return
    setRenameError(null)
    try {
      // Optimistic local overlay + cross-tab notify
      try {
        const { data: { user } } = await supabaseBrowser.auth.getUser()
        const userId = user?.id
        if (userId) {
          namesOverlay.set(userId, id, next, true)
          setOverlayNames((m) => ({ ...m, [id]: next }))
          bcRef.current?.postMessage({ type: 'order.updated', id, title: next })
        }
      } catch {}

      // Server rename endpoint prefers orders.title
      const res = await fetch(`/api/orders/${id}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: next }),
      })
      if (!res.ok) {
        // Fallback: client-side RLS update via Supabase session
        const { error } = await supabaseBrowser.from('orders').update({ title: next }).eq('id', id)
        if (error) {
          setRenameError('Save failed. Please try again.')
          return false
        }
      }
      // Confirm overlay if server value matches eventually
      try {
        const { data: { user } } = await supabaseBrowser.auth.getUser()
        const userId = user?.id
        if (userId) namesOverlay.confirm(userId, id, next)
      } catch {}
      setLocalNames((m) => ({ ...m, [id]: next }))
      return true
    } catch {
      setRenameError('Save failed. Please try again.')
      return false
    }
  }

  async function deleteOrder(id: string) {
    try {
      setRowErrors((m) => { const n = { ...m }; delete n[id]; return n })
      let res: Response
      try {
        res = await authedFetch(`/api/orders/${id}`, { method: 'DELETE' })
      } catch (err: any) {
        const msg = String(err?.message || '')
        if (msg.includes('not_authenticated')) {
          setRowErrors((m) => ({ ...m, [id]: 'Please sign in.' }))
          return
        }
        // Fallback to plain fetch with credentials as a last resort
        res = await fetch(`/api/orders/${id}`, { method: 'DELETE', credentials: 'include' })
      }
      if (!res.ok) {
        let msg = 'Delete failed. Please try again.'
        try {
          const body = await res.json()
          if (body?.error === 'not_authenticated') msg = 'Please sign in.'
          else if (body?.error === 'forbidden') msg = 'You do not have access.'
          else if (body?.error === 'not_found') msg = 'Project not found.'
          else if (body?.error === 'has_children') msg = 'Cannot delete: linked items remain.'
        } catch {}
        setRowErrors((m) => ({ ...m, [id]: msg }))
        return
      }

      // Remove local overlay name and broadcast deletion
      try {
        const { data: { user } } = await supabaseBrowser.auth.getUser()
        const userId = user?.id
        if (userId) namesOverlay.remove(userId, id)
      } catch {}
      try { bcRef.current?.postMessage({ type: 'order.deleted', id }) } catch {}

      setHiddenIds((prev) => new Set([...Array.from(prev), id]))
      if (id === activeSessionId) {
        // Move focus to last-visited or any remaining session
        const fallback = sessions?.find((s) => s.id !== id && !hiddenIds.has(s.id))?.id || lastVisitedSessionId || null
        if (fallback) onSessionSelect?.(fallback)
      }
    } catch {
      setRowErrors((m) => ({ ...m, [id]: 'Delete failed. Please try again.' }))
    }
  }

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (!profileOpen) return
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (buttonRef.current?.contains(target)) return
      setProfileOpen(false)
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [profileOpen])

  async function handleSignOut() {
    setSigningOut(true)
    try {
      await supabaseBrowser.auth.signOut()
      setProfileOpen(false)
    } catch {
      // ignore
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <aside
      className={`panel relative flex h-full flex-shrink-0 flex-col items-start gap-3 p-3 transition-all duration-400 ease-in-out ${widthClass}`}
    >
      <div
        className={`${
          expanded ? 'flex w-[40px] items-center justify-start pl-[3px]' : 'flex w-[64px] items-center justify-start pl-[3px]'
        } mt-1 mb-2`}
      >
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setProfileOpen((open) => !open)}
          className={`relative flex h-8 w-8 items-center justify-center rounded-mdx border border-white/10 bg-teal/15 text-sm font-semibold text-white hover:bg-teal/25 focus-ring ${
            profileOpen ? 'ring-2 ring-teal/70' : ''
          }`}
          aria-label={isAuthed ? 'Account menu' : 'Sign in'}
          style={{ cursor: 'pointer' }}
        >
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center leading-[1]">
            {profileInitial}
          </span>
        </button>
      </div>
      {profileOpen && (
        <div
          ref={menuRef}
          className="absolute left-[70px] top-3 z-30 w-56 rounded-lg border border-white/10 bg-black/90 p-3 text-sm text-textPrimary shadow-2xl backdrop-blur"
        >
          <div className="mb-3">
            <div className="text-xs uppercase tracking-wide text-textMuted">Account</div>
            <div className="mt-1 text-[13px] text-white">{profileEmail ?? 'Guest'}</div>
          </div>
          <div className="flex flex-col gap-1">
            <Link
              href="/settings"
              data-rail-nav="1"
              className="rounded-md px-2 py-1.5 text-sm text-textPrimary hover:bg-white/10"
              onClick={() => setProfileOpen(false)}
            >
              User settings
            </Link>
            <Link
              href="/orders"
              data-rail-nav="1"
              className="rounded-md px-2 py-1.5 text-sm text-textPrimary hover:bg-white/10"
              onClick={() => setProfileOpen(false)}
            >
              Orders
            </Link>
          </div>
          <div className="mt-3 border-t border-white/10 pt-3">
            {isAuthed ? (
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                className="w-full rounded-md border border-white/10 px-2 py-1.5 text-sm text-textMuted hover:bg-white/10 disabled:opacity-50"
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            ) : (
              <Link
                href="/?auth=signup"
                data-rail-nav="1"
                className="block w-full rounded-md border border-teal/40 px-2 py-1.5 text-center text-sm text-teal hover:bg-teal/10"
                onClick={() => setProfileOpen(false)}
              >
                Sign in / Create account
              </Link>
            )}
          </div>
        </div>
      )}
      <div className={navRowClass}>
        <div className={iconFrameClass}>
          <div className={iconCellClass}>
            <Item href="/" label="Home" icon={<span className="text-teal">◎</span>} />
          </div>
        </div>
        <span className={`${labelBaseClass} ${labelStateClass}`}>Home</span>
      </div>

      <div className={navRowClass}>
        <div className={iconFrameClass}>
          <div className={iconCellClass}>
            <Item
              href="/store"
              label="Upload your STLs"
              isNew
              icon={
                <span className="relative inline-flex h-8 w-8 items-center justify-center text-[10px] font-semibold uppercase tracking-[0.4em] text-teal">
                  <span className="absolute inset-0 rounded-mdx bg-teal/20 blur-sm" />
                  <span className="relative">New</span>
                </span>
              }
            />
          </div>
        </div>
        <span className={`${labelBaseClass} ${labelStateClass}`}>Store</span>
      </div>

      <div className={navRowClass}>
        <div className={iconFrameClass}>
          <div className={iconCellClass}>
            <Item
              href="/sales"
              label="Connect storefronts"
              isNew
              icon={
                <span className="relative inline-flex h-8 w-8 items-center justify-center text-[10px] font-semibold uppercase tracking-[0.4em] text-teal">
                  <span className="absolute inset-0 rounded-mdx bg-teal/20 blur-sm" />
                  <span className="relative">New</span>
                </span>
              }
            />
          </div>
        </div>
        <span className={`${labelBaseClass} ${labelStateClass}`}>Sales</span>
      </div>

      <div className={navRowClass}>
        <div className={iconFrameClass}>
          <div className={iconCellClass}>
            <button
              type="button"
              data-rail-action="new"
              onClick={(event) => {
                event.stopPropagation()
                onStartNew?.()
              }}
              className="flex h-8 w-8 items-center justify-center rounded-mdx border border-white/10 bg-white/5 text-xl text-textPrimary transition-all duration-400 ease-in-out hover:bg-white/10 focus-ring cursor-pointer"
              aria-label="Start new fabrication"
            >
              +
            </button>
          </div>
        </div>
        <span className={`${labelBaseClass} ${labelStateClass}`}>New project</span>
      </div>
      <div className="h-px w-full border-b border-white/10" />
      {expanded ? (
        <div className="flex w-full flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto pr-1">
            {sessionItems.length === 0 ? (
              <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-textMuted">
                Start a fabrication to see it here.
              </div>
            ) : (
              sessionItems
                .filter((s) => !hiddenIds.has(s.id))
                // Hide drafts (no activity) from the sidebar: if first_activity_at not present in this env, fall back to status
                .filter((s: any) => Boolean(s.first_activity_at) || (typeof s.status === 'string' && s.status.toLowerCase() !== 'new'))
                .map((session) => {
                const active = session.id === activeSessionId
                const lastVisited = !active && session.id === lastVisitedSessionId
                const baseClass = active
                  ? 'bg-teal/15 text-teal'
                  : lastVisited
                  ? 'bg-white/10 text-textPrimary'
                  : 'hover:bg-white/10 text-textPrimary'
                return (
                  <div
                    key={session.id}
                    data-session-item="1"
                    className={`group relative mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] transition ${baseClass} cursor-pointer`}
                    onMouseEnter={() => onSessionHover?.(session.id)}
                    onClick={(e) => {
                      // Ignore clicks while renaming this row or when clicking on kebab/menu areas
                      if (renamingId === session.id) return
                      const target = e.target as HTMLElement | null
                      if (target?.closest('[data-rail-item-menu]')) return
                      if (target?.closest('[data-rail-item-kebab]')) return
                      onSessionSelect?.(session.id)
                    }}
                    onKeyDown={(e) => {
                      if (renamingId === session.id) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSessionSelect?.(session.id)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={(overlayNames[session.id] || localNames[session.id] || (session as any).title || renderPrompt(session.prompt_text)) + ' — open project'}
                  >
                    {renamingId === session.id ? (
                      <form
                        className="flex w-full flex-col gap-1"
                        data-rail-item-menu
                        onSubmit={async (e) => {
                          e.preventDefault()
                          const ok = await renameOrder(session.id, renameValue)
                          if (ok) {
                            setRenamingId(null)
                            setMenuOpenId(null)
                            onRenamingChange?.(false)
                          }
                        }}
                      >
                        <input
                          autoFocus
                          className="flex-1 rounded bg-white/10 px-2 py-1 text-sm text-textPrimary outline-none ring-1 ring-white/10 focus:ring-teal/50"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              setRenamingId(null)
                              setMenuOpenId(null)
                              onRenamingChange?.(false)
                            }
                          }}
                          placeholder="Project name"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="mt-1 flex items-center gap-2">
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1 rounded bg-teal px-2 py-1 text-sm text-black"
                            title="Save name (Enter)"
                            aria-label="Save name"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span>✓</span>
                            <span className="sr-only">Save</span>
                          </button>
                          <button
                            type="button"
                            className="rounded border border-white/20 px-2 py-1 text-sm text-textPrimary hover:bg-white/10"
                            onClick={() => {
                              setRenamingId(null)
                              setMenuOpenId(null)
                              onRenamingChange?.(false)
                              setRenameError(null)
                            }}
                            onClickCapture={(e) => e.stopPropagation()}
                          >
                            Cancel
                          </button>
                          {renameError && (
                            <span className="ml-2 text-xs text-warning" role="status">{renameError}</span>
                          )}
                        </div>
                      </form>
                    ) : (
                      <>
                        <div
                          className="flex-1 truncate text-left text-sm leading-snug text-textPrimary/90 group-hover:text-white"
                          title={overlayNames[session.id] || localNames[session.id] || (session as any).title || renderPrompt(session.prompt_text)}
                        >
                          {overlayNames[session.id] || localNames[session.id] || (session as any).title || renderPrompt(session.prompt_text)}
                        </div>
                        {rowErrors[session.id] && (
                          <span className="ml-2 text-xs text-warning" role="status">{rowErrors[session.id]}</span>
                        )}
                        <button
                          type="button"
                          data-rail-item-kebab
                          className="invisible ml-1 rounded px-1 py-0.5 text-textMuted hover:text-textPrimary group-hover:visible"
                          aria-label="Project menu"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMenuOpenId((v) => (v === session.id ? null : session.id))
                          }}
                        >
                          ⋯
                        </button>
                        {menuOpenId === session.id && (
                          <div data-rail-item-menu className="absolute z-30 mt-8 w-44 rounded-md border border-white/10 bg-black/90 p-1 text-sm text-textPrimary shadow-2xl">
                            <button
                              className="block w-full rounded px-2 py-1.5 text-left hover:bg-white/10"
                              onClick={(e) => {
                                e.stopPropagation()
                                setRenamingId(session.id)
                                setRenameValue(overlayNames[session.id] || localNames[session.id] || (session as any).title || renderPrompt(session.prompt_text))
                                // Close the popover so the rename UI is stable
                                setMenuOpenId(null)
                                onRenamingChange?.(true)
                              }}
                            >
                              Rename…
                            </button>
                            <button
                              className="block w-full rounded px-2 py-1.5 text-left text-warning hover:bg-white/10"
                              onClick={(e) => {
                                e.stopPropagation()
                                void deleteOrder(session.id)
                                setMenuOpenId(null)
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {showOperator && (
        <div className="mb-1">
          <Item href="/operator" label="Operator" icon={<span className="text-warning">⚙</span>} />
        </div>
      )}
    </aside>
  )
}
