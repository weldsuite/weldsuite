import { useRouterState } from '@tanstack/react-router'
import {
  intlLocale,
  ShopLayout,
  ShopProvider,
  t,
  type MenuLink,
  type ShopData,
  type ShopInfo,
  useShop,
} from '@weldsuite/storefront-theme'
import { useMemo, type ReactNode } from 'react'
import { showsPrices } from '@/lib/access'
import { resolveMenuLink } from '@/lib/menu-links'
import type { ShopPayload } from '@/lib/payload'
import { Analytics, ConsentBanner, ConsentProvider } from './consent'
import { PreviewBridge } from './preview-bridge'
import { SHOP_SLOTS } from './slots'

/** The legal pages, by the slugs the theme's page templates give them. */
function legalPaths(pages: ShopPayload['pages']): ShopInfo['legalPaths'] {
  const path = (slug: string) => (pages.some((page) => page.slug === slug) ? `/pages/${slug}` : null)
  return { terms: path('terms'), privacy: path('privacy'), withdrawal: path('withdrawal') }
}

export function useShopInfo(payload: ShopPayload): ShopInfo {
  const path = useRouterState({ select: (state) => state.location.pathname })
  return useMemo(
    () => ({
      name: payload.name,
      locale: payload.locale,
      intlLocale: intlLocale(payload.locale),
      strings: t(payload.locale),
      channel: payload.channel,
      theme: payload.theme,
      menus: payload.menus,
      access: payload.access,
      signedIn: payload.signedIn,
      showPrices: showsPrices(payload.access, payload.signedIn),
      cartCount: payload.cartCount,
      path,
      preview: payload.preview,
      formsPortalUrl: payload.formsPortalUrl,
      resolveLink: (link: MenuLink) => resolveMenuLink(link, payload.pages),
      legalPaths: legalPaths(payload.pages),
    }),
    [payload, path],
  )
}

/** Every page: the shop in context, the header and footer groups, and the consent banner. */
export function ShopRoot({ payload, children }: Readonly<{ payload: ShopPayload; children: ReactNode }>) {
  const shop = useShopInfo(payload)
  return (
    <ShopProvider shop={shop} data={{}} slots={SHOP_SLOTS}>
      <ConsentProvider initial={payload.consent}>
        <ShopLayout groups={payload.groups} banner={payload.analytics?.banner && !payload.preview ? <ConsentBanner /> : null}>
          {children}
        </ShopLayout>
        <Analytics payload={payload} />
      </ConsentProvider>
      {payload.preview ? <PreviewBridge origins={payload.editorOrigins} /> : null}
    </ShopProvider>
  )
}

/** A page's own data (product, cart, listing, …) for the sections inside it. */
export function PageData({ data, children }: Readonly<{ data: ShopData; children: ReactNode }>) {
  const { shop, slots } = useShop()
  return (
    <ShopProvider shop={shop} data={data} slots={slots}>
      {children}
    </ShopProvider>
  )
}
