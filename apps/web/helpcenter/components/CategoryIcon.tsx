import clsx from 'clsx'

const GlyphPaths = (
  <path
    d="M4 7.5A2.5 2.5 0 0 1 6.5 5h4l2 2h5A2.5 2.5 0 0 1 20 9.5v7A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-9Z"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinejoin="round"
  />
)

/**
 * Category icon. `tile` (default) renders the icon in a rounded accent tile for
 * cards; `plain` renders a small bare glyph for the sidebar. If the workspace
 * set an emoji as the folder icon we show it; otherwise a neutral "collection"
 * glyph is used.
 */
export function CategoryIcon({
  icon,
  variant = 'tile',
}: {
  icon?: string | null
  variant?: 'tile' | 'plain'
}) {
  const isEmoji = !!icon && /\p{Extended_Pictographic}/u.test(icon)

  if (variant === 'plain') {
    return isEmoji ? (
      <span className="text-base leading-none">{icon}</span>
    ) : (
      <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 text-zinc-400" aria-hidden="true">
        {GlyphPaths}
      </svg>
    )
  }

  return (
    <span
      className={clsx(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--hc-accent)]/10 text-[var(--hc-accent)]',
      )}
    >
      {isEmoji ? (
        <span className="text-lg leading-none">{icon}</span>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
          {GlyphPaths}
        </svg>
      )}
    </span>
  )
}
