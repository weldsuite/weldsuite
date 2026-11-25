/// <reference types="vite/client" />
import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { intlLocale, safeImageSrc, themeCssVariables, type ThemeSettings } from '@weldsuite/storefront-theme'
import type { CSSProperties, ReactNode } from 'react'
import { NotFoundPage } from '@/components/not-found'
import { ShopRoot } from '@/components/shop-root'
import { headTags } from '@/lib/seo'
import { getShop } from '@/lib/server/loaders/root'
import appCss from '@/styles.css?url'

export const Route = createRootRoute({
  loader: () => getShop(),
  head: ({ loaderData }) => {
    const tags = headTags(loaderData?.head)
    const favicon = safeImageSrc(loaderData?.theme.faviconUrl)
    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        ...(loaderData ? [{ name: 'theme-color', content: loaderData.theme.colors.background }] : []),
        ...tags.meta,
        ...(loaderData ? [{ property: 'og:site_name', content: loaderData.name }, { property: 'og:locale', content: intlLocale(loaderData.locale).replace('-', '_') }] : []),
        // A preview of unpublished changes is never indexed.
        ...(loaderData?.preview ? [{ name: 'robots', content: 'noindex' }] : []),
      ],
      // Without a favicon of its own the shop asks for none (no /favicon.ico round trip).
      links: [{ rel: 'stylesheet', href: appCss }, { rel: 'icon', href: favicon ?? 'data:,' }],
    }
  },
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: NotFoundPage,
})

function themeStyle(theme: ThemeSettings | undefined): CSSProperties | undefined {
  return theme ? (themeCssVariables(theme) as CSSProperties) : undefined
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  const payload = Route.useLoaderData()
  return (
    <html lang={payload?.locale ?? 'en'} style={themeStyle(payload?.theme)}>
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

function RootComponent() {
  const payload = Route.useLoaderData()
  return (
    <ShopRoot payload={payload}>
      <Outlet />
    </ShopRoot>
  )
}
