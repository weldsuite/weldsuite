import Link from 'next/link'
import type { Folder } from '@/lib/api-client'

interface BreadcrumbsProps {
  folder?: Folder
  articleTitle?: string
}

export function Breadcrumbs({ folder, articleTitle }: BreadcrumbsProps) {
  return (
    <div className="space-y-3">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
        <Link
          href="/"
          className="text-zinc-400 transition-colors hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          Home
        </Link>
        {folder && (
          <>
            <span className="text-zinc-300 dark:text-zinc-600">/</span>
            <Link
              href={`/category/${folder.id}`}
              className="font-medium text-[var(--hc-accent)] transition-opacity hover:opacity-80"
            >
              {folder.name}
            </Link>
          </>
        )}
      </nav>
      {articleTitle && (
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">
          {articleTitle}
        </h1>
      )}
    </div>
  )
}
