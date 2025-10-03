import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Icon Preview',
}

export default function IconPreviewPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-obsidian p-8 text-textPrimary">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Replicator Glyph</h1>
        <p className="max-w-xl text-sm text-textMuted">
          This page renders the concentric-ring glyph at a large scale so you can grab a clean screenshot or download the
          source vector file for favicons and brand assets.
        </p>
      </div>
      <div className="flex items-center justify-center rounded-[48px] border border-white/10 bg-panel/80 p-16 shadow-[0_0_80px_rgba(46,230,214,0.35)]">
        <img
          src="/replicator-glyph.svg"
          alt="Replicator concentric-ring glyph"
          className="h-[320px] w-[320px]"
          draggable={false}
        />
      </div>
      <div className="flex flex-col items-center gap-2 text-sm text-textMuted">
        <a
          href="/replicator-glyph.svg"
          download
          className="rounded-full border border-teal/50 bg-teal/10 px-4 py-2 text-sm font-medium text-teal hover:bg-teal/20"
        >
          Download SVG (1024px)
        </a>
        <span>Need a PNG? Open the SVG in Figma/Illustrator or run `sharp`/`magick` to export your preferred sizes.</span>
      </div>
    </div>
  )
}
