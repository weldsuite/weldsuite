'use client'

import { useLazyI18n } from '@weldsuite/i18n/lazy-provider'
import { languageNames, stableLanguages, type Language } from '@weldsuite/i18n/locales'
import clsx from 'clsx'

interface LocaleSwitcherProps {
  className?: string
}

export function LocaleSwitcher({ className }: LocaleSwitcherProps) {
  const { language, setLanguage } = useLazyI18n()

  return (
    <label className={clsx('relative inline-flex items-center', className)}>
      <span className="sr-only">Language</span>
      <select
        value={language}
        onChange={(e) => setLanguage(e.target.value as Language)}
        className="appearance-none rounded-lg border-0 bg-transparent px-2 py-1.5 pr-7 text-sm text-slate-600 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/20 dark:text-slate-400 dark:hover:bg-slate-800"
      >
        {stableLanguages.map((code) => (
          <option key={code} value={code}>
            {languageNames[code]}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-1.5 h-3 w-3 fill-slate-400"
        viewBox="0 0 8 6"
        aria-hidden="true"
      >
        <path d="M0 0l4 6 4-6z" />
      </svg>
    </label>
  )
}
