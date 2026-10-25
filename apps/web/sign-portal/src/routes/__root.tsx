/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { getPageData } from '@/lib/page-data'
import { dictionaries } from '@/lib/i18n'
import { MessageScreen } from '@/components/message-screen'
import appCss from '@/styles.css?url'

export const Route = createRootRoute({
  loader: () => getPageData(),
  // The language and disclosure version don't change while the page is open.
  staleTime: Infinity,
  head: ({ loaderData }) => {
    const t = dictionaries[loaderData?.locale ?? 'en']
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { title: t.metaTitle },
        { name: 'description', content: t.metaDescription },
        // Signing links must never end up in a search index.
        { name: 'robots', content: 'noindex, nofollow' },
      ],
      links: [{ rel: 'stylesheet', href: appCss }],
    }
  },
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
  component: Outlet,
})

function RootDocument({ children }: Readonly<{ children: React.ReactNode }>) {
  const { locale } = Route.useLoaderData()
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
  const t = dictionaries[Route.useLoaderData().locale]
  return <MessageScreen title={t.home.title} body={t.home.body} footer={t.poweredBy} />
}
