"use client"
import { useState } from 'react'

const STYLES = ['Figurine', 'Mechanical', 'Organic'] as const
type Style = typeof STYLES[number]

export default function StyleChips() {
  const [active, setActive] = useState<Style>('Mechanical')
  return (
    <div className="flex gap-2">
      {STYLES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => setActive(s)}
          className={`rounded-mdx border px-3 py-1.5 text-sm focus-ring ${
            active === s ? 'border-teal bg-teal/10 text-teal' : 'border-white/10 text-textMuted hover:bg-white/5'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  )
}

