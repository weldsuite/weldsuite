import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';
import { menuPermissionAllows } from './menu-permission';

describe('WeldCommerce module menu', () => {
  const config = MODULE_CONFIGS.weldcommerce!;
  const items = (language: typeof en) => config.getMenuItems(language).flatMap((group) => group.items);

  it('is recognised from its URLs', () => {
    expect(getModuleKey('/weldcommerce/products')).toBe('weldcommerce');
    expect(getModuleKey('/weldcommerce/categories')).toBe('weldcommerce');
    expect(getModuleKey('/weldcommerce/orders')).toBe('weldcommerce');
    expect(getModuleKey('/weldcommerce/orders/new')).toBe('weldcommerce');
    expect(getModuleKey('/weldcommerce/discounts')).toBe('weldcommerce');
  });

  it('lists the overview, the orders, the catalogue and the discounts, each behind its read permission', () => {
    expect(items(en).map((item) => [item.href, item.permission])).toEqual([
      ['/weldcommerce', undefined],
      ['/weldcommerce/orders', 'orders:read'],
      ['/weldcommerce/products', 'products:read'],
      ['/weldcommerce/categories', 'categories:read'],
      ['/weldcommerce/discounts', 'discounts:read'],
    ]);
  });

  it('keeps no settings page in the menu: its settings live in Settings → Apps', () => {
    expect(items(en).some((item) => item.href.includes('/settings'))).toBe(false);
  });

  it('shows Orders and Discounts only to a member who may read them', () => {
    const orders = items(en).find((item) => item.href === '/weldcommerce/orders')!;
    const discounts = items(en).find((item) => item.href === '/weldcommerce/discounts')!;
    expect(menuPermissionAllows(orders.permission, (permission) => permission === 'orders:read')).toBe(true);
    expect(menuPermissionAllows(orders.permission, (permission) => permission === 'discounts:read')).toBe(false);
    expect(menuPermissionAllows(discounts.permission, (permission) => permission === 'discounts:read')).toBe(true);
    expect(menuPermissionAllows(discounts.permission, (permission) => permission === 'orders:read')).toBe(false);
  });

  it('shows Categories only to a member who may read categories', () => {
    const categories = items(en).find((item) => item.href === '/weldcommerce/categories')!;
    expect(menuPermissionAllows(categories.permission, (permission) => permission === 'categories:read')).toBe(true);
    expect(menuPermissionAllows(categories.permission, (permission) => permission === 'products:read')).toBe(false);
  });

  it('translates the section names', () => {
    expect(items(en).map((item) => item.title)).toEqual(['Overview', 'Orders', 'Products', 'Categories', 'Discounts']);
    expect(items(nl as unknown as typeof en).map((item) => item.title)).toEqual([
      'Overzicht',
      'Orders',
      'Producten',
      'Categorieën',
      'Kortingen',
    ]);
  });
});
