import { useEffect, useRef, useState } from 'react'

type ShareAction = 'share' | 'copy' | 'stl' | 'original' | 'print_stl' | 'print_stl_sized'

export default function ViewerControls({ onReset, onToggleWire, onShare, onRotateX, onRotateY, onRotateZ, onUpright, sourceExt, disabledShare, hasPrintReady, preparing, onManualDownload, canExportViewer, canPrepareStl = true }: { onReset?: () => void; onToggleWire?: () => void; onShare?: (a: ShareAction) => void; onRotateX?: () => void; onRotateY?: () => void; onRotateZ?: () => void; onUpright?: () => void; sourceExt?: string | null; disabledShare?: boolean; hasPrintReady?: boolean; preparing?: boolean; onManualDownload?: () => void; canExportViewer?: boolean; canPrepareStl?: boolean }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current) return
      if (rootRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  function act(a: ShareAction) {
    setOpen(false)
    onShare?.(a)
  }

  return (
    <div ref={rootRef} className="pointer-events-auto absolute right-3 top-3 z-40 flex gap-2">
      <div className="flex items-center gap-1 rounded-mdx bg-black/50 px-1 py-1 text-sm text-textPrimary border border-white/10">
        <button onClick={onRotateX} className="rounded px-1.5 py-0.5 hover:bg-white/10" title="Rotate X">X⟲</button>
        <button onClick={onRotateY} className="rounded px-1.5 py-0.5 hover:bg-white/10" title="Rotate Y">Y⟲</button>
        <button onClick={onRotateZ} className="rounded px-1.5 py-0.5 hover:bg-white/10" title="Rotate Z">Z⟲</button>
      </div>
      <div className="relative z-40">
        <button
          aria-label="Share"
          onClick={() => setOpen((v) => !v)}
          className="rounded-mdx bg-black/50 p-1.5 text-sm text-textPrimary border border-white/10 hover:bg-white/10 focus-ring"
          title="Menu"
        >
          {/* Share icon (iOS-style): arrow up out of a container */}
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v11" />
            <path d="M8 7l4-4 4 4" />
            <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
          </svg>
        </button>
        {open && (
          <div className="absolute right-0 z-50 mt-2 w-56 rounded-md border border-white/10 bg-black/70 p-1 shadow-modal backdrop-blur">
            <button
              className={`block w-full rounded px-2 py-1.5 text-left text-sm ${!canPrepareStl || preparing ? 'opacity-60 cursor-not-allowed text-textMuted' : 'text-textPrimary hover:bg-white/10'}`}
              onClick={() => act('print_stl')}
              title={hasPrintReady
                ? 'Download a repaired, watertight STL'
                : canPrepareStl
                  ? 'Prepare a repaired STL, then auto-download'
                  : 'Mesh repair still running — wait for it to finish before exporting'}
              disabled={!!preparing || !canPrepareStl}
            >
              <span className="inline-flex items-center gap-2">
                {preparing && <span className="inline-block h-[12px] w-[12px] animate-spin rounded-full border-2 border-teal/60 border-t-transparent" />}
                <span>Prepare & Download STL (auto‑starts)</span>
              </span>
            </button>
            {onManualDownload && (
              <button
                className="mt-0.5 block w-full rounded px-2 pb-1 text-left text-[11px] text-textMuted hover:text-teal"
                onClick={onManualDownload}
                type="button"
              >
                If it doesn’t start, retry download
              </button>
            )}
            <hr className="my-1 border-white/10" />
            <button
              className={`block w-full rounded px-2 py-1.5 text-left text-sm text-textPrimary hover:bg-white/10 ${disabledShare ? 'opacity-40 pointer-events-none' : ''}`}
              onClick={() => act('share')}
            >
              Share…
            </button>
            <button
              className={`block w-full rounded px-2 py-1.5 text-left text-sm text-textPrimary hover:bg-white/10 ${disabledShare ? 'opacity-40 pointer-events-none' : ''}`}
              onClick={() => act('copy')}
            >
              Copy link
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
