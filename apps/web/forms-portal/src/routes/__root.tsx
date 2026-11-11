/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute, useMatches } from '@tanstack/react-router'
import { MessageScreen } from '@/components/message-screen'
import { PortalProvider, usePortal } from '@/components/portal-context'
import { getPageData, type PageData } from '@/lib/page-data'
import appCss from '@/styles.css?url'

export const Route = createRootRoute({
  loader: () => getPageData(),
  staleTime: Infinity,
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: loaderData?.strings.meta.landingTitle ?? 'WeldForms' },
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

/** A form page brings the language of its own form; every other page uses the request's. */
function useLanguage(): PageData {
  const root = Route.useLoaderData()
  const matches = useMatches()
  for (let i = matches.length - 1; i >= 0; i--) {
    const data = matches[i]?.loaderData as Partial<PageData> | undefined
    if (data?.locale && data.strings) return { locale: data.locale, strings: data.strings }
  }
  return root
}

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  const { locale, strings } = useLanguage()
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <PortalProvider locale={locale} strings={strings}>
          {children}
        </PortalProvider>
        <Scripts />
      </body>
    </html>
  )
}

function NotFound() {
  const { t } = usePortal()
  return <MessageScreen title={t.notFound.title} body={t.notFound.body} />
}
