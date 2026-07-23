'use client'

import { Suspense, useState } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { useTranslations } from '@weldsuite/i18n/lazy-provider'

interface SearchBarProps {
  defaultValue?: string
  autoFocus?: boolean
  /** `hero` renders the larger landing-page variant. */
  size?: 'hero' | 'default'
}

function SearchBarInner({ defaultValue, autoFocus, size = 'default' }: SearchBarProps) {
  const router = useRouter()
  const [query, setQuery] = useState(defaultValue?.trim() || '')
  const t = useTranslations('common')
  const hero = size === 'hero'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = query.trim()
    if (q) router.push(`/search?q=${encodeURIComponent(q)}`)
  }

  return (
    <form onSubmit={handleSubmit} className="relative" role="search">
      <svg
        className={clsx(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-zinc-400',
          hero ? 'left-4 h-5 w-5' : 'left-3.5 h-[18px] w-[18px]',
        )}
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="m17 17-3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus={autoFocus}
        placeholder={t.helpcenter.searchPlaceholder}
        aria-label={t.actions.search}
        className={clsx(
          'w-full appearance-none rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-sm transition-colors',
          'placeholder:text-zinc-400 focus:border-[var(--hc-accent)] focus:ring-4 focus:ring-[var(--hc-accent)]/15 focus:outline-none',
          'dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:shadow-none dark:placeholder:text-zinc-500',
          hero ? 'py-3.5 pr-4 pl-12 text-base' : 'py-2.5 pr-4 pl-10 text-sm',
        )}
      />
    </form>
  )
}

export function SearchBar(props: SearchBarProps) {
  // useTranslations suspends while the `common` chunk loads; keep a neutral
  // placeholder so the form area doesn't pop in.
  return (
    <Suspense
      fallback={
        <div
          className={clsx(
            'w-full rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
            props.size === 'hero' ? 'h-[58px]' : 'h-[42px]',
          )}
        />
      }
    >
      <SearchBarInner {...props} />
    </Suspense>
  )
}
