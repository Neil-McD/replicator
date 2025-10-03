export type Phase = 'Specify' | 'Synthesize' | 'Stabilize Mesh' | 'Slice & Quote' | 'Authorize' | 'Fabricate'

export default function ProgressCard({ active }: { active: Phase }) {
  const phases: Phase[] = ['Specify', 'Synthesize', 'Stabilize Mesh', 'Slice & Quote', 'Authorize', 'Fabricate']
  return (
    <div className="panel p-4">
      <div className="text-xs uppercase tracking-wide text-textMuted mb-2">Fabrication Phases</div>
      <ol className="space-y-2">
        {phases.map((p) => (
          <li key={p} className="flex items-center justify-between">
            <span className={`text-sm ${p === active ? 'text-textPrimary' : 'text-textMuted'}`}>{p}</span>
            <span className={`h-1 w-24 rounded bg-white/10 ${p === active ? 'bg-teal' : ''}`} />
          </li>
        ))}
      </ol>
    </div>
  )
}

