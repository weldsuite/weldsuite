import type { HelpcenterConfig } from '@/lib/api-client'

export function Footer({ config }: { config: HelpcenterConfig }) {
  const year = new Date().getFullYear()
  return (
    <footer className="mt-24 border-t border-zinc-200/70 dark:border-zinc-800/70">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-6 py-8 text-sm text-zinc-500 sm:flex-row dark:text-zinc-400">
        <p>{config.footerText || `© ${year} ${config.siteName || 'Help Center'}`}</p>
        <a
          href="https://weldsuite.org"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          Powered by{' '}
          <span className="font-medium text-zinc-700 dark:text-zinc-200">WeldDesk</span>
        </a>
      </div>
    </footer>
  )
}
