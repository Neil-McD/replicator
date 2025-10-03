"use client"
import React, { useEffect, useRef, useState } from "react"

type AttachmentChip = {
  assetId: string
  url: string
  label?: string | null
  pending?: boolean
  name?: string | null
}

export default function CommandInput({
  onSend,
  disabled,
  loading,
  inputRef,
  onUpload,
  attachments,
  onAttachmentRemove,
}: {
  onSend: (text: string) => void
  disabled?: boolean
  loading?: boolean
  inputRef?: React.RefObject<HTMLTextAreaElement>
  onUpload?: (files: FileList) => void
  attachments?: AttachmentChip[]
  onAttachmentRemove?: (assetId: string) => void
}) {
  const [val, setVal] = useState("")
  const internalRef = useRef<HTMLTextAreaElement | null>(null)
  const taRef = inputRef || internalRef

  const chips = Array.isArray(attachments) ? attachments : []
  const isDisabled = disabled || !val.trim()

  function autosize() {
    const ta = taRef.current
    if (!ta) return
    const line = 24 // px, approximates leading-6
    const minH = line * 1 // 1 row
    const maxH = line * 4 // 4 rows
    ta.style.height = "auto"
    const next = Math.min(maxH, Math.max(minH, ta.scrollHeight))
    ta.style.height = `${next}px`
  }

  useEffect(() => { autosize() }, [val])

  function send() {
    if (isDisabled) return
    const text = val.trim()
    if (!text) return
    onSend(text)
    setVal("")
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // IME/composition guard
    const anyEvt = e.nativeEvent as any
    const composing = anyEvt?.isComposing || false
    if (composing) return
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="px-3 pb-3 pt-2">
      <div className="rounded-xl border border-white/10 bg-black/40 shadow-[inset_0_0_0_1px_rgba(46,230,214,.06)]">
        {chips.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3 pb-2">
            {chips.map((chip) => (
              <div key={chip.assetId} className="group relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border border-white/12 bg-black/60">
                <img
                  src={chip.url}
                  alt={`attachment ${chip.label ?? chip.assetId}`}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
                {chip.pending && (
                  <div className="absolute inset-0 grid place-items-center bg-black/65 text-[10px] font-semibold uppercase tracking-wider text-white/80">
                    Pending
                  </div>
                )}
                {onAttachmentRemove && (
                  <button
                    type="button"
                    className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-white/40 bg-black/75 text-[11px] font-bold text-white/85 opacity-0 transition group-hover:opacity-100"
                    onClick={() => onAttachmentRemove(chip.assetId)}
                    title="Remove attachment"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-3 px-3 pb-3">
          <div className="flex items-center gap-2 self-stretch pt-2">
            <span className="select-none font-mono text-white/40">›</span>
            <label className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border border-white/10 bg-white/5 text-white/60 hover:bg-white/10" title="Attach image(s)">
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e)=>{ if (e.currentTarget.files && e.currentTarget.files.length) onUpload?.(e.currentTarget.files) }} />
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 1 1 4.24 4.24L9.64 16.19a1 1 0 1 1-1.41-1.41l8.49-8.49" />
              </svg>
            </label>
          </div>
          <textarea
            ref={taRef}
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={chips.length ? 'Tell Atom what to do with the attachment…' : 'Describe what to make…'}
            aria-label="Describe what to make"
            rows={1}
            className="flex-1 resize-none overflow-hidden bg-transparent py-2 font-mono text-[0.95rem] leading-6 text-white/90 outline-none placeholder:text-white/30"
          />
          <button
            type="button"
            aria-label="Send"
            onClick={send}
            disabled={isDisabled}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-teal-300/30 bg-teal-400/20 text-teal-100 shadow-[0_0_14px_rgba(46,230,214,.25)] hover:bg-teal-400/30 active:scale-95 disabled:opacity-40 disabled:shadow-none"
            title="Send (Enter) — Shift+Enter for newline"
          >
            {!loading ? (
              <svg viewBox="0 0 24 24" className="h-[14px] w-[14px] fill-current"><path d="M2 21L23 12 2 3l5 7-5 8 7-5z" /></svg>
            ) : (
              <span className="inline-block h-[14px] w-[14px] animate-spin rounded-full border-2 border-teal/60 border-t-transparent" />
            )}
          </button>
        </div>
      </div>
      <div className="mt-2 hidden pl-1 text-[11px] text-white/40 md:block">Enter to send · Shift+Enter for newline</div>
    </div>
  )
}
