/** A shop for tests: English, a B2C channel in euros, the classic preset. */

import type { ReactNode } from 'react';
import { ShopProvider, type ShopData, type ShopInfo, type ShopSlots } from './context';
import { presetSettings } from './defaults';
import { intlLocale, t } from './strings';

export function testShop(overrides: Partial<ShopInfo> = {}): ShopInfo {
  const locale = overrides.locale ?? 'en';
  return {
    name: 'Test shop',
    locale,
    intlLocale: intlLocale(locale),
    strings: t(locale),
    channel: { id: 'ch_1', name: 'Test shop', audience: 'b2c', currency: 'EUR', pricesIncludeTax: true, guestCheckout: true, paymentMethods: ['mollie'] },
    theme: presetSettings('classic'),
    menus: {},
    access: 'public',
    signedIn: false,
    showPrices: true,
    cartCount: 0,
    path: '/',
    preview: false,
    formsPortalUrl: null,
    resolveLink: () => '/',
    legalPaths: { terms: null, privacy: null, withdrawal: null },
    ...overrides,
  };
}

export function TestShop({ shop, data = {}, slots = {}, children }: Readonly<{ shop?: Partial<ShopInfo>; data?: ShopData; slots?: ShopSlots; children: ReactNode }>) {
  return (
    <ShopProvider shop={testShop(shop)} data={data} slots={slots}>
      {children}
    </ShopProvider>
  );
}
