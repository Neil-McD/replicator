"use client"
import { forwardRef, useCallback, type KeyboardEvent } from 'react'
import classNames from 'classnames'

export type CheckedState = boolean | 'indeterminate'

type HoloCheckboxProps = {
  checked: CheckedState
  onCheckedChange?: (state: CheckedState) => void
  ariaLabel?: string
  className?: string
  disabled?: boolean
}

const CheckGlyph = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
    <path
      d="M6.6 11.2 3.4 8l1.12-1.12L6.6 8.96l4.88-4.88L12.6 5.2 6.6 11.2Z"
      fill="currentColor"
    />
  </svg>
)

const MinusGlyph = () => (
  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5">
    <rect x="3" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor" />
  </svg>
)

const HoloCheckbox = forwardRef<HTMLButtonElement, HoloCheckboxProps>(
  ({ checked, onCheckedChange, ariaLabel, className, disabled = false }, ref) => {
    const handleToggle = useCallback(() => {
      if (disabled) return
      const next: CheckedState = checked === 'indeterminate' ? true : !checked
      onCheckedChange?.(next)
    }, [checked, disabled, onCheckedChange])

    const handleKey = useCallback(
      (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          handleToggle()
        }
      },
      [handleToggle]
    )

    const isChecked = checked === true
    const isIndeterminate = checked === 'indeterminate'

    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={isIndeterminate ? 'mixed' : isChecked}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={handleToggle}
        onKeyDown={handleKey}
        className={classNames(
          'group relative inline-flex h-[18px] w-[18px] items-center justify-center rounded-md border border-white/20 bg-black/70 transition',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
          (isChecked || isIndeterminate) && 'border-teal/60 bg-gradient-to-br from-teal/25 to-teal/5 shadow-[0_0_10px_rgba(46,230,214,0.3)]',
          !disabled && 'hover:border-teal/50 hover:shadow-[0_0_8px_rgba(46,230,214,0.18)]',
          disabled && 'cursor-not-allowed opacity-60',
          className,
        )}
      >
        <span className="absolute inset-[1px] rounded-[6px] border border-white/10 bg-white/5 mix-blend-soft-light" />
        <span
          className={classNames(
            'relative flex h-full w-full items-center justify-center text-teal transition-opacity duration-150',
            !(isChecked || isIndeterminate) && 'opacity-0 group-hover:opacity-40'
          )}
        >
          {isIndeterminate ? <MinusGlyph /> : <CheckGlyph />}
        </span>
      </button>
    )
  }
)

HoloCheckbox.displayName = 'HoloCheckbox'

export default HoloCheckbox
