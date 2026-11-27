/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import { MessageScreen } from '@/components/message-screen'
import { dictionaries, localeOfLoaderData, type Locale } from '@/lib/i18n'
import { getBrowserLocale } from '@/lib/server-fns'
import appCss from '@/styles.css?url'

export const Route = createRootRoute({
  // The browser's language: what a page without a document (the landing page, a dead link) is written in.
  loader: () => getBrowserLocale(),
  staleTime: Infinity,
  head: ({ loaderData }) => {
    const t = dictionaries[localeOfLoaderData(loaderData) ?? 'en']
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: t.home.title },
        { name: 'description', content: t.metaDescription },
        // A link with a token in it must never be indexed, and never leaves the page in a Referer.
        { name: 'robots', content: 'noindex, nofollow' },
        { name: 'referrer', content: 'no-referrer' },
      ],
      links: [{ rel: 'stylesheet', href: appCss }],
    }
  },
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
  component: Outlet,
})

/** The page's language: the deepest route's (a document's own), else the browser's. */
function usePageLocale(): Locale {
  return useRouterState({
    select: (state) => state.matches.reduce<Locale | null>((found, match) => localeOfLoaderData(match.loaderData) ?? found, null) ?? 'en',
  })
}

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = usePageLocale()
  return (
    <html lang={locale}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function NotFound() {
  const t = dictionaries[usePageLocale()]
  return <MessageScreen title={t.home.title} body={t.home.body} />
}
