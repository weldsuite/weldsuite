import type { ReactNode } from 'react';
import { useShop } from '../context';
import { SectionRenderer } from '../section-renderer';
import type { SiteDocument } from '../types';

/**
 * Every page of the shop: a skip link, the header group, `<main>` and the
 * footer group. `banner` (the consent banner) goes after the footer, so it
 * is last in the reading order and never covers the skip link.
 */
export function ShopLayout({ groups, children, banner }: Readonly<{ groups: SiteDocument['groups']; children: ReactNode; banner?: ReactNode }>) {
  const { shop } = useShop();
  return (
    <div className="flex min-h-dvh flex-col bg-shop-bg font-body text-shop-fg">
      <a href="#main" className="shop-skip-link">
        {shop.strings.common.skipToContent}
      </a>
      {shop.preview ? (
        <p className="bg-shop-fg px-4 py-1 text-center text-xs font-medium text-shop-bg">{shop.strings.preview.banner}</p>
      ) : null}
      <SectionRenderer sections={groups.header} list="header" />
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </main>
      <SectionRenderer sections={groups.footer} list="footer" />
      {banner}
    </div>
  );
}
