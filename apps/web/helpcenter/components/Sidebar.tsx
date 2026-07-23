'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import clsx from 'clsx'
import type { Folder } from '@/lib/api-client'
import { CategoryIcon } from '@/components/CategoryIcon'

interface SidebarProps {
  folders: Folder[]
}

export function Sidebar({ folders }: SidebarProps) {
  const pathname = usePathname()
  const rootFolders = folders.filter((f) => !f.parentId)
  const childrenOf = (parentId: string) => folders.filter((f) => f.parentId === parentId)
  const isActive = (id: string) => pathname.endsWith(`/category/${id}`)

  return (
    <nav className="text-sm">
      {/* Search trigger (full search lives on /search) */}
      <Link
        href="/search"
        className="mb-7 flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-zinc-400 transition-colors hover:border-zinc-300 hover:text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:text-zinc-300"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="m17 17-3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="flex-auto">Search…</span>
        <kbd className="rounded border border-zinc-200 px-1.5 font-sans text-[11px] text-zinc-400 dark:border-zinc-700">
          ⌘K
        </kbd>
      </Link>

      <div className="space-y-7">
        {rootFolders.map((root) => {
          const kids = childrenOf(root.id)
          return (
            <div key={root.id}>
              <Link
                href={`/category/${root.id}`}
                className={clsx(
                  'flex items-center gap-2 text-xs font-semibold tracking-wide uppercase transition-colors',
                  isActive(root.id)
                    ? 'text-[var(--hc-accent)]'
                    : 'text-zinc-900 hover:text-zinc-600 dark:text-white dark:hover:text-zinc-300',
                )}
              >
                <CategoryIcon icon={root.icon} variant="plain" />
                {root.name}
              </Link>

              {kids.length > 0 && (
                <ul className="mt-2 ml-2 space-y-0.5 border-l border-zinc-200 pl-4 dark:border-zinc-800">
                  {kids.map((child) => (
                    <li key={child.id}>
                      <Link
                        href={`/category/${child.id}`}
                        className={clsx(
                          'block rounded-md py-1 transition-colors',
                          isActive(child.id)
                            ? 'font-medium text-[var(--hc-accent)]'
                            : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200',
                        )}
                      >
                        {child.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </nav>
  )
}
