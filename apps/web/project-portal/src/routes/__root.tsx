/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { getPageData } from '@/lib/page-data'
import { MessageScreen } from '@/components/message-screen'
import { PortalProvider, usePortal } from '@/components/portal-context'
import appCss from '@/styles.css?url'

export const Route = createRootRoute({
  loader: () => getPageData(),
  // The language does not change while the page is open, except when the
  // reader switches it: that invalidates this loader.
  staleTime: Infinity,
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: loaderData?.strings.meta.title ?? 'Project portal' },
      ...(loaderData ? [{ name: 'description', content: loaderData.strings.meta.description }] : []),
      // A client's projects must never end up in a search index.
      { name: 'robots', content: 'noindex, nofollow' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
    ],
  }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
  component: Outlet,
})

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  const { locale, strings } = Route.useLoaderData()
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <PortalProvider locale={locale} strings={strings}>
            {children}
          </PortalProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  )
}

function NotFound() {
  const { t } = usePortal()
  return (
    <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
      <MessageScreen title={t.notFound.title} body={t.notFound.body} />
    </div>
  )
}
