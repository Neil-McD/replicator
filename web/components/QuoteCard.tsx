type Props = {
  previewUrl?: string
  minutes?: number
  grams?: number
  priceCents?: number
  productCents?: number
  laborCents?: number
  shippingCents?: number
  totalCents?: number
  canPay?: boolean
  onPay?: () => void
  onDismiss?: () => void
  onContinueEditing?: () => void
}

export default function QuoteCard({
  previewUrl,
  minutes,
  grams,
  priceCents,
  productCents,
  laborCents,
  shippingCents,
  totalCents,
  canPay,
  onPay,
  onDismiss,
  onContinueEditing
}: Props) {
  // Use new itemized pricing if available, fall back to legacy price_cents
  const finalTotal = totalCents ?? priceCents
  const hasItemized = productCents != null && laborCents != null && shippingCents != null
  const price = typeof finalTotal === 'number' ? `$${(finalTotal / 100).toFixed(2)}` : '—'

  return (
    <div className="panel p-4 relative">
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="absolute top-2 right-2 text-textMuted hover:text-white text-lg leading-none w-6 h-6 flex items-center justify-center"
          title="Dismiss quote"
        >
          ×
        </button>
      )}
      <div className="text-xs uppercase tracking-wide text-textMuted mb-2">Quote</div>
      <div className="aspect-video w-full overflow-hidden rounded-mdx bg-black/40 mb-3 border border-white/5">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="Slicer preview" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-textMuted text-sm">Preview pending</div>
        )}
      </div>

      {hasItemized ? (
        <div className="space-y-2 text-sm mb-4 rounded border border-white/10 bg-black/20 p-3">
          <div className="flex justify-between">
            <span className="text-textMuted">Product</span>
            <span className="font-mono text-textPrimary">${((productCents ?? 0) / 100).toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-textMuted">Labor & handling</span>
            <span className="font-mono text-textPrimary">${((laborCents ?? 0) / 100).toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-textMuted">Shipping</span>
            <span className="font-mono text-textPrimary">${((shippingCents ?? 0) / 100).toFixed(2)}</span>
          </div>
          <div className="border-t border-white/10 pt-2 flex justify-between font-medium">
            <span className="text-textPrimary">Total</span>
            <span className="font-mono text-teal">{price}</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2 text-sm mb-4">
          <div>
            <div className="text-textMuted">Time</div>
            <div className="font-mono tabular-nums">{minutes ?? '—'} min</div>
          </div>
          <div>
            <div className="text-textMuted">Filament</div>
            <div className="font-mono tabular-nums">{grams ?? '—'} g</div>
          </div>
          <div>
            <div className="text-textMuted">Price</div>
            <div className="font-mono tabular-nums">{price}</div>
          </div>
        </div>
      )}

      <button
        className="w-full rounded-mdx bg-teal px-3 py-2 font-medium text-black hover:brightness-110 focus-ring disabled:opacity-50"
        disabled={!canPay}
        onClick={onPay}
      >
        Pay
      </button>

      {onContinueEditing && (
        <button
          onClick={onContinueEditing}
          className="mt-2 w-full rounded-mdx border border-white/20 bg-transparent px-3 py-2 text-sm text-textMuted hover:text-white"
        >
          ↩ Keep editing this model
        </button>
      )}
    </div>
  )
}
