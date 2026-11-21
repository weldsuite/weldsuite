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
  });

  it('lists the overview, the products and the categories, each behind its read permission', () => {
    expect(items(en).map((item) => [item.href, item.permission])).toEqual([
      ['/weldcommerce', undefined],
      ['/weldcommerce/products', 'products:read'],
      ['/weldcommerce/categories', 'categories:read'],
    ]);
  });

  it('shows Categories only to a member who may read categories', () => {
    const categories = items(en).find((item) => item.href === '/weldcommerce/categories')!;
    expect(menuPermissionAllows(categories.permission, (permission) => permission === 'categories:read')).toBe(true);
    expect(menuPermissionAllows(categories.permission, (permission) => permission === 'products:read')).toBe(false);
  });

  it('translates the section names', () => {
    expect(items(en).map((item) => item.title)).toEqual(['Overview', 'Products', 'Categories']);
    expect(items(nl as unknown as typeof en).map((item) => item.title)).toEqual(['Overzicht', 'Producten', 'Categorieën']);
  });
});
