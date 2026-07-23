'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import clsx from 'clsx'

import { ThemeSelector } from '@/components/ThemeSelector'
import { LocaleSwitcher } from '@/components/LocaleSwitcher'
import type { HelpcenterConfig } from '@/lib/api-client'

interface HeaderProps {
  config: HelpcenterConfig
}

export function Header({ config }: HeaderProps) {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={clsx(
        'sticky top-0 z-40 border-b transition-colors duration-200',
        scrolled
          ? 'border-zinc-200/70 bg-white/80 backdrop-blur-md dark:border-zinc-800/70 dark:bg-zinc-950/80'
          : 'border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-6">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Home">
          {config.logo && (
            <>
              <Image
                src={config.logo}
                alt={config.siteName || 'Logo'}
                width={28}
                height={28}
                className={clsx('h-7 w-auto', config.logoDark && 'dark:hidden')}
              />
              {config.logoDark && (
                <Image
                  src={config.logoDark}
                  alt={config.siteName || 'Logo'}
                  width={28}
                  height={28}
                  className="hidden h-7 w-auto dark:block"
                />
              )}
            </>
          )}
          <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-white">
            {config.siteName || 'Help Center'}
          </span>
        </Link>

        <div className="flex items-center gap-1.5">
          <Link
            href="/search"
            className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white/60 px-3 py-1.5 text-sm text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="m17 17-3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="hidden sm:inline">Search</span>
          </Link>
          <LocaleSwitcher className="relative z-10" />
          <ThemeSelector className="relative z-10" />
        </div>
      </div>
    </header>
  )
}
