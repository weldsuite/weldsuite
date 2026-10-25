/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { LazyI18nProvider } from '@weldsuite/i18n/lazy-provider'
import { defaultLanguage } from '@weldsuite/i18n/locales'
import { getSite, type SiteData } from '@/lib/api-client'
import { Header } from '@/components/Header'
import { Footer } from '@/components/Footer'
import { Sidebar } from '@/components/Sidebar'
import { NotFound } from '@/components/NotFound'
import appCss from '@/styles/tailwind.css?url'

export const Route = createRootRoute({
  loader: () => getSite(),
  // Branding and navigation rarely change; don't refetch them on every
  // client-side navigation.
  staleTime: 60_000,
  head: ({ loaderData }) => {
    const config = loaderData?.config
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: config?.metaTitle || config?.siteName || 'Help Center' },
        { name: 'description', content: config?.metaDescription || 'Find answers to your questions' },
        ...(config?.ogImage ? [{ property: 'og:image', content: config.ogImage }] : []),
      ],
      links: [
        { rel: 'stylesheet', href: appCss },
        // A workspace can override the default WeldDesk favicon with its own.
        { rel: 'icon', href: config?.favicon || '/icon.svg' },
      ],
    }
  },
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
  component: SiteLayout,
})

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  // The root loader may have thrown (unknown host), so read its data loosely.
  const site = useRouterState({
    select: (s) => s.matches[0]?.loaderData as SiteData | undefined,
  })
  const language = site?.language ?? defaultLanguage

  return (
    <html lang={language} className="h-full antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-full bg-white text-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
        <ThemeProvider attribute="class" disableTransitionOnChange>
          <LazyI18nProvider initialLanguage={language}>{children}</LazyI18nProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}

/**
 * Workspace-supplied custom CSS is injected into a public page, so strip the
 * constructs that turn CSS into an exfiltration / script vector before it
 * reaches the DOM: `</style>` breakouts, `@import`, `expression()`,
 * `javascript:` urls, and IE `behavior` / `-moz-binding`.
 */
function sanitizeCss(css: string): string {
  return css
    .replace(/<\/?\s*style/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/-moz-binding/gi, '')
    .replace(/behavior\s*:/gi, '')
}

/** Only accept a real hex colour for the accent CSS var; fall back otherwise. */
function accentColor(value?: string | null): string | undefined {
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : undefined
}

function SiteLayout() {
  const site = Route.useLoaderData() as SiteData | undefined
  // A notFound thrown by the root loader (no help center on this host) still
  // renders this component, without loader data.
  if (!site) return <NotFound />

  const { config, folders } = site
  const accent = accentColor(config.primaryColor)

  return (
    <div
      className="flex min-h-full w-full flex-col"
      style={accent ? ({ '--hc-accent': accent } as React.CSSProperties) : undefined}
    >
      <Header config={config} />

      <div className="mx-auto flex w-full max-w-7xl flex-auto px-4 sm:px-6 lg:px-8">
        {folders.length > 0 && (
          <aside className="hidden w-64 shrink-0 lg:block">
            <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-10 pr-6">
              <Sidebar folders={folders} />
            </div>
          </aside>
        )}
        <main className="min-w-0 flex-auto">
          <Outlet />
        </main>
      </div>

      <Footer config={config} />

      {config.customCss && (
        <style dangerouslySetInnerHTML={{ __html: sanitizeCss(config.customCss) }} />
      )}
    </div>
  )
}
