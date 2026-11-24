import { createServerFn } from '@tanstack/react-start';
import { isShopLocale } from '@weldsuite/storefront-theme';
import type { ShopPayload } from '../../payload';
import { makeHead, withoutTrailingSlashes } from '../../seo';
import { rendererConfig } from '../config';
import { headContext } from '../head';
import { getConsent } from '../session';
import { activeCompany, currentCart, currentShopper, shopRequest } from '../shop';

/** The WeldPanel collector, when it is an http(s) origin. */
function collector(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin + withoutTrailingSlashes(url.pathname) : null;
  } catch {
    return null;
  }
}

/** The shop for every page: language, theme, menus, header and footer, who is signed in, the cart count. */
export const getShop = createServerFn({ method: 'GET' }).handler(async (): Promise<ShopPayload> => {
  const shop = await shopRequest();
  const { site, doc } = shop;
  const config = rendererConfig();
  const [shopper, cart] = await Promise.all([currentShopper(shop), currentCart(shop).catch(() => null)]);
  const company = activeCompany(shopper);
  const b2b = site.channel.audience === 'b2b';
  const projectKey = doc.settings.analytics?.weldpanelProjectKey?.trim();
  const collectorUrl = collector(doc.settings.analytics?.collectorUrl);
  return {
    host: shop.host,
    primaryOrigin: site.primaryOrigin,
    locale: isShopLocale(site.locale) ? site.locale : 'en',
    preview: site.preview,
    versionId: site.version.id,
    name: site.channel.name,
    channel: site.channel,
    theme: doc.theme.settings,
    groups: doc.groups,
    notFoundSections: doc.templates.notFound,
    menus: doc.menus,
    pages: doc.pages.map((page) => ({ id: page.id, title: page.title, slug: page.slug })),
    access: doc.settings.access,
    signedIn: shopper !== null,
    b2b: { buyer: b2b && company !== null, approver: b2b && (company?.role === 'approver' || company?.role === 'admin') },
    cartCount: cart?.itemCount ?? 0,
    analytics: projectKey && collectorUrl ? { projectKey, collectorUrl, banner: doc.settings.cookieBanner } : null,
    consent: getConsent(),
    editorOrigins: site.preview ? config.editorOrigins : [],
    formsPortalUrl: config.formsPortalUrl,
    head: makeHead(headContext(shop), { title: null, path: '/' }),
  };
});
