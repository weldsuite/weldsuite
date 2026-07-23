import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="flex min-h-screen w-full items-center justify-center px-6">
      <div className="text-center">
        <p className="text-sm font-semibold text-[var(--hc-accent)]">404</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          This help center doesn&apos;t exist, or the page has been moved.
        </p>
        <Link
          href="/"
          className="mt-8 inline-flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          Go back home
        </Link>
      </div>
    </div>
  )
}
