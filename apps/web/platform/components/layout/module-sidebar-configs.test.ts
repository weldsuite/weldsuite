import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { getModuleKey, MODULE_CONFIGS } from './module-sidebar-configs';

describe('module sidebars', () => {
  // AGENTS.md, "App settings live in Settings": an app's settings are reached
  // only from Settings → Apps (`/settings/apps/{appCode}`), never from the
  // app's own menu.
  it.each(Object.keys(MODULE_CONFIGS).filter((key) => key !== 'settings'))('%s has no settings item', (key) => {
    const groups = MODULE_CONFIGS[key]!.getMenuItems(en);
    expect(groups.map((group) => group.group)).not.toContain(en.navigation.moduleSidebar.groups.settings);
    for (const item of groups.flatMap((group) => group.items)) {
      expect(item.href).not.toMatch(/^\/settings(\/|$)/);
      expect(item.href).not.toMatch(/\/settings(\/|$|\?)/);
    }
  });

  it('keeps WeldBooks fiscal periods, month-end work, in the app', () => {
    const hrefs = MODULE_CONFIGS.weldbooks!.getMenuItems(en).flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs).toContain('/weldbooks/fiscal-periods');
  });
});

describe('the WeldBooks menu', () => {
  const groups = () => MODULE_CONFIGS.weldbooks!.getMenuItems(en);
  const hrefs = () => groups().flatMap((group) => group.items.map((item) => item.href));

  it('leads with Overview and To process, with no heading over them', () => {
    const [first] = groups();
    expect(first?.group).toBe('');
    expect(first?.items.map((item) => item.href)).toEqual(['/weldbooks', '/weldbooks/to-process']);
  });

  it('follows the owner-first order and names the accountant\'s books last before tax', () => {
    const g = en.navigation.moduleSidebar.groups;
    expect(groups().map((group) => group.group)).toEqual(['', g.sales, g.purchases, g.bank, g.contacts, g.reports, g.accountant, g.tax]);
  });

  it('turns credit notes into a filter of Invoices and customers and suppliers into one list', () => {
    expect(hrefs()).not.toContain('/weldbooks/credit-notes');
    expect(hrefs()).not.toContain('/weldbooks/customers');
    expect(hrefs()).not.toContain('/weldbooks/suppliers');
    expect(hrefs()).toContain('/weldbooks/contacts');
  });

  it('leaves out what does not exist yet: quotes, unbilled time and pay bills', () => {
    for (const later of ['/weldbooks/quotes', '/weldbooks/unbilled-time', '/weldbooks/pay-bills']) {
      expect(hrefs()).not.toContain(later);
    }
  });

  it('adds Cash flow and General ledger, which no menu reached before', () => {
    expect(hrefs()).toContain('/weldbooks/reports/cash-flow');
    expect(hrefs()).toContain('/weldbooks/reports/general-ledger');
  });

  it('keeps the US tax group as it was', () => {
    const tax = groups().find((group) => group.group === en.navigation.moduleSidebar.groups.tax);
    expect(tax?.items.map((item) => item.href)).toEqual([
      '/weldbooks/sales-tax',
      '/weldbooks/sales-tax/certificates',
      '/weldbooks/sales-tax/nexus',
      '/weldbooks/form-1099',
      '/weldbooks/tax-calendar',
    ]);
  });

  it('names the Dutch menu in the glossary words', async () => {
    const { nl } = await import('@weldsuite/i18n/locales/nl');
    const titles = MODULE_CONFIGS.weldbooks!.getMenuItems(nl as typeof en).flatMap((group) => group.items.map((item) => item.title));
    for (const word of ['Te verwerken', 'Inbox', 'Inkoopfacturen en bonnen', 'Contacten', 'Grootboekrekeningen', 'Memoriaal']) {
      expect(titles).toContain(word);
    }
    const dutchGroups = MODULE_CONFIGS.weldbooks!.getMenuItems(nl as typeof en).map((group) => group.group);
    expect(dutchGroups).toContain('Bank');
    expect(dutchGroups).toContain('Boekhouder');
  });
});

describe('getModuleKey', () => {
  it('maps module paths to their module', () => {
    expect(getModuleKey('/weldcrm/companies')).toBe('weldcrm');
    expect(getModuleKey('/weldsheets/sh_123')).toBe('weldsheets');
    expect(getModuleKey('/welddocs/doc_123')).toBe('welddocs');
    expect(getModuleKey('/')).toBe('home');
  });

  it('gives settings the unified sidebar', () => {
    expect(getModuleKey('/settings')).toBe('settings');
    expect(getModuleKey('/settings/apps/weldhr')).toBe('settings');
  });

  it('keys custom objects by slug, on the list and on a record', () => {
    expect(getModuleKey('/objects/machines')).toBe('object:machines');
    expect(getModuleKey('/objects/machines/rec_123')).toBe('object:machines');
  });

  it('keys hosted WeldApps by code', () => {
    expect(getModuleKey('/apps/time-tracker/reports')).toBe('user-app:time-tracker');
  });

  it('leaves pages without a module sidebar unmapped', () => {
    expect(getModuleKey('/appstore')).toBeNull();
    expect(getModuleKey('/documents/file_1')).toBeNull();
    expect(getModuleKey('/objects')).toBeNull();
  });
});
