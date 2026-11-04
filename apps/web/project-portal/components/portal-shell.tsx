import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { FolderKanban } from 'lucide-react'
import type { PortalMe } from '@weldsuite/app-api-client/schemas/project-portal'
import { AccountMenu, LanguageSwitch, ThemeToggle } from '@/components/header-controls'
import { usePortal } from '@/components/portal-context'

/**
 * The frame of every page under a workspace: the header (the workspace's name
 * once someone is signed in, language, theme, account), the content, a footer.
 */
export function PortalShell({
  workspace,
  account,
  children,
}: Readonly<{ workspace: string; account: PortalMe | null; children: ReactNode }>) {
  const { t } = usePortal()
  const brand = (
    <>
      <span
        aria-hidden="true"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"
      >
        <FolderKanban className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{account?.workspace.name ?? t.header.subtitle}</span>
        {account && <span className="block truncate text-xs text-muted-foreground">{t.header.subtitle}</span>}
      </span>
    </>
  )

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        {t.common.skipToContent}
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          {account ? (
            <Link
              to="/$workspace/projects"
              params={{ workspace }}
              className="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {brand}
            </Link>
          ) : (
            <div className="flex min-w-0 items-center gap-2.5">{brand}</div>
          )}
          <div className="flex-1" />
          <LanguageSwitch />
          <ThemeToggle />
          {account && <AccountMenu workspace={workspace} account={account} />}
        </div>
      </header>
      <main id="content" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8">
        {children}
      </main>
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">{t.common.poweredBy}</footer>
    </div>
  )
}
