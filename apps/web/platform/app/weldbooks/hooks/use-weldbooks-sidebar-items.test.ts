import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { en } from '@weldsuite/i18n/locales/en';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { MODULE_CONFIGS } from '@/components/layout/module-sidebar-configs';
import type { TodoSummary } from '@/lib/api/domains/weldbooks';
import type { CurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { DEFAULT_TERMINOLOGY, NO_JURISDICTION_FEATURES } from '@/lib/weldbooks/jurisdiction';
import { isSupplierContactForm, useWeldbooksSidebarItems } from './use-weldbooks-sidebar-items';

let jurisdiction: Partial<CurrentJurisdiction>;

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});

vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => jurisdiction,
}));

const route = vi.hoisted(() => ({ pathname: '/weldbooks', search: '' }));
vi.mock('@/lib/router', () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));

const access = vi.hoisted(() => ({ accountant: true, processing: false, quotes: false, timeBilling: false }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => (permission === 'journal:create' ? access.accountant : true) }),
}));
vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  isFeatureAvailable: (feature: string) =>
    (feature === 'books-bank-processing' && access.processing) ||
    (feature === 'books-quotes' && access.quotes) ||
    (feature === 'books-time-billing' && access.timeBilling),
}));

const todo = vi.hoisted(() => ({ summary: undefined as unknown, enabledSeen: [] as boolean[] }));
vi.mock('@/hooks/queries/use-weldbooks-todo-queries', () => ({
  useTodoSummary: (options: { enabled?: boolean } = {}) => {
    todo.enabledSeen.push(options.enabled ?? true);
    return { data: todo.summary };
  },
}));

// The real menu: the groups, order and items the module ships.
const MENU = () => MODULE_CONFIGS.weldbooks!.getMenuItems(en);

function hrefs(groups: MenuGroupProps[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.href));
}

function adjust(menu: MenuGroupProps[] = MENU()) {
  const { result } = renderHook(() => useWeldbooksSidebarItems(true));
  return result.current.adjust(menu);
}

function summary(kinds: TodoSummary['kinds'], total: number): TodoSummary {
  return { total, currency: 'EUR', kinds };
}

const known = (features = NO_JURISDICTION_FEATURES, terminology = DEFAULT_TERMINOLOGY) => ({
  features,
  terminology,
  isResolved: true,
  isError: false,
});

describe('useWeldbooksSidebarItems', () => {
  beforeEach(() => {
    route.pathname = '/weldbooks';
    route.search = '';
    access.accountant = true;
    access.processing = false;
    access.quotes = false;
    access.timeBilling = false;
    localStorage.clear();
    todo.summary = undefined;
    todo.enabledSeen = [];
    jurisdiction = { features: NO_JURISDICTION_FEATURES, terminology: DEFAULT_TERMINOLOGY, isResolved: false, isError: false };
  });

  it('hides every gated item until the jurisdiction is known, and drops the empty tax group', () => {
    const groups = adjust();
    const all = hrefs(groups);
    for (const gated of [
      '/weldbooks/vat',
      '/weldbooks/annual-reports',
      '/weldbooks/received-nfe',
      '/weldbooks/payment-runs',
      '/weldbooks/deposits',
      '/weldbooks/banking/statements',
      '/weldbooks/sales-tax',
      '/weldbooks/form-1099',
      '/weldbooks/tax-calendar',
      '/weldbooks/reports/tax-worksheet',
    ]) {
      expect(all).not.toContain(gated);
    }
    expect(groups.map((g) => g.group)).not.toContain(en.navigation.moduleSidebar.groups.tax);
    expect(all).toContain('/weldbooks/invoices');
  });

  it('shows the US screens for a US entity, without the VAT return', () => {
    jurisdiction = known({ ...NO_JURISDICTION_FEATURES, salesTax: true, form1099: true });
    const all = hrefs(adjust());
    for (const us of ['/weldbooks/payment-runs', '/weldbooks/sales-tax', '/weldbooks/form-1099', '/weldbooks/tax-calendar', '/weldbooks/reports/tax-worksheet']) {
      expect(all).toContain(us);
    }
    expect(all).not.toContain('/weldbooks/vat');
  });

  it('puts the VAT return under Reports for a Dutch entity, and no US screens', () => {
    jurisdiction = known({ ...NO_JURISDICTION_FEATURES, vatReturn: true, icp: true });
    const groups = adjust();
    const reports = groups.find((g) => g.group === en.navigation.moduleSidebar.groups.reports);
    expect(reports?.items.map((i) => i.href)).toContain('/weldbooks/vat');
    expect(hrefs(groups)).not.toContain('/weldbooks/sales-tax');
  });

  it('shows the tax return, labelled GST Returns, for an Indian entity', () => {
    jurisdiction = known(
      { ...NO_JURISDICTION_FEATURES, gstReturn: true },
      { ...DEFAULT_TERMINOLOGY, tax: 'gst', taxId: 'gstin', registrationId: 'pan' },
    );
    const groups = adjust();
    expect(hrefs(groups)).not.toContain('/weldbooks/sales-tax');
    const tax = groups.flatMap((g) => g.items).find((i) => i.href === '/weldbooks/vat');
    expect(tax?.title).toBe('GST Returns');
  });

  it('shows the apuração, labelled Taxes, and the received NF-e inbox for a Brazilian entity', () => {
    jurisdiction = known(
      { ...NO_JURISDICTION_FEATURES, brTaxReturn: true, fiscalDocuments: true, spedEcd: true },
      { ...DEFAULT_TERMINOLOGY, tax: 'tributos', taxId: 'cnpj', registrationId: 'ie' },
    );
    const groups = adjust();
    expect(hrefs(groups)).toContain('/weldbooks/received-nfe');
    const tax = groups.flatMap((g) => g.items).find((i) => i.href === '/weldbooks/vat');
    expect(tax?.title).toBe('Taxes (apuração)');
  });

  it('hides the received NF-e inbox for entities without fiscal documents', () => {
    jurisdiction = known({ ...NO_JURISDICTION_FEATURES, gstReturn: true });
    expect(hrefs(adjust())).not.toContain('/weldbooks/received-nfe');
  });

  it('keeps gated items hidden when the jurisdictions fail to load', () => {
    jurisdiction = { features: NO_JURISDICTION_FEATURES, terminology: DEFAULT_TERMINOLOGY, isResolved: false, isError: true };
    expect(hrefs(adjust())).not.toContain('/weldbooks/sales-tax');
  });

  it('leaves the menu alone while the module is not open', () => {
    const { result } = renderHook(() => useWeldbooksSidebarItems(false));
    const menu = MENU();
    expect(result.current.adjust(menu)).toBe(menu);
    // The summary is not polled from another module's screen.
    expect(todo.enabledSeen).toEqual([false]);
  });
});

describe('the owner-first menu', () => {
  beforeEach(() => {
    route.pathname = '/weldbooks';
    route.search = '';
    todo.summary = undefined;
    jurisdiction = known({ ...NO_JURISDICTION_FEATURES, vatReturn: true, icp: true });
  });

  it('lists the groups owner first: what to do, sales, purchases, the bank, contacts, reports, the accountant', () => {
    const groups = adjust();
    const g = en.navigation.moduleSidebar.groups;
    expect(groups.map((group) => group.group)).toEqual(['', g.sales, g.purchases, g.bank, g.contacts, g.reports, g.accountant]);
  });

  it('starts with Overview and To process', () => {
    const [first] = adjust();
    expect(first?.items.map((i) => [i.title, i.href])).toEqual([
      ['Overview', '/weldbooks'],
      ['To process', '/weldbooks/to-process'],
    ]);
  });

  it('names the purchases and bank items in the owner words', () => {
    const titles = (group: string) => adjust().find((g) => g.group === group)?.items.map((i) => i.title);
    const g = en.navigation.moduleSidebar.groups;
    expect(titles(g.sales)).toEqual(['Invoices', 'Recurring']);
    expect(titles(g.purchases)).toEqual(['Inbox', 'Bills & receipts', 'Pay bills']);
    expect(titles(g.bank)).toEqual(['Transactions', 'Accounts', 'Rules', 'Reconciliation', 'Import', 'Bank feeds']);
    expect(titles(g.contacts)).toEqual(['Contacts']);
    expect(titles(g.reports)).toEqual([
      'Profit & loss',
      'Balance sheet',
      'VAT Returns',
      'Aged receivables',
      'Aged payables',
      'Cash flow',
      'General ledger',
    ]);
    expect(titles(g.accountant)).toEqual([
      'Journal entries',
      'Ledger accounts',
      'Fiscal periods',
      'Trial balance',
      // The annual report (`annual-reports`) is not offered on Global.
      'Fixed assets',
      'Payroll',
    ]);
  });

  it('has one Contacts item instead of Customers and Suppliers, and no Credit notes item', () => {
    const all = hrefs(adjust());
    expect(all).toContain('/weldbooks/contacts');
    for (const gone of ['/weldbooks/customers', '/weldbooks/suppliers', '/weldbooks/credit-notes']) {
      expect(all).not.toContain(gone);
    }
  });

  it('keeps Contacts active on the old customer and supplier routes and the new-supplier form', () => {
    const contacts = () => adjust().flatMap((g) => g.items).find((i) => i.href === '/weldbooks/contacts');
    expect(contacts()?.isActive).toBe(false);
    for (const pathname of ['/weldbooks/contacts', '/weldbooks/suppliers', '/weldbooks/customers/prt_1/edit']) {
      route.pathname = pathname;
      expect(contacts()?.isActive).toBe(true);
    }
    route.pathname = '/weldbooks/customers/add';
    route.search = 'role=supplier';
    expect(contacts()?.isActive).toBe(true);
  });
});

describe('Quotes in the menu', () => {
  beforeEach(() => {
    jurisdiction = { ...known() };
  });

  it('is hidden where the edition has no quotes (Global)', () => {
    expect(hrefs(adjust())).not.toContain('/weldbooks/quotes');
  });

  it('is listed under Sales, between Invoices and Recurring, where the edition has quotes', () => {
    access.quotes = true;
    const groups = adjust();
    const sales = groups.find((group) => group.group === en.navigation.moduleSidebar.groups.sales);
    expect(sales?.items.map((item) => item.href)).toEqual(['/weldbooks/invoices', '/weldbooks/quotes', '/weldbooks/recurring']);
    expect(sales?.items[1]?.title).toBe('Quotes');
  });
});

describe('Unbilled time in the menu', () => {
  beforeEach(() => {
    jurisdiction = { ...known() };
  });

  it('is hidden where the edition does not bill time (Global)', () => {
    expect(hrefs(adjust())).not.toContain('/weldbooks/time/unbilled');
  });

  it('is listed under Sales, after Quotes, where the edition bills time, with no count to fetch', () => {
    access.quotes = true;
    access.timeBilling = true;
    const sales = adjust().find((group) => group.group === en.navigation.moduleSidebar.groups.sales);
    expect(sales?.items.map((item) => item.href)).toEqual([
      '/weldbooks/invoices',
      '/weldbooks/quotes',
      '/weldbooks/time/unbilled',
      '/weldbooks/recurring',
    ]);
    const unbilled = sales?.items.find((item) => item.href === '/weldbooks/time/unbilled');
    expect(unbilled?.title).toBe('Unbilled time');
    // No summary call exists for the hours of all customers: no badge, and no extra request per customer.
    expect(unbilled?.badge).toBeUndefined();
  });
});

describe('the Accountant group', () => {
  const accountantGroup = () => adjust().find((g) => g.group === en.navigation.moduleSidebar.groups.accountant);

  beforeEach(() => {
    route.pathname = '/weldbooks';
    route.search = '';
    access.accountant = true;
    localStorage.clear();
    jurisdiction = known();
  });

  it('is open for a member who books journal entries', () => {
    const group = accountantGroup();
    expect(group?.collapsed).toBe(false);
    expect(group?.items.length).toBeGreaterThan(1);
    expect(group?.onToggleCollapse).toBeTypeOf('function');
  });

  it('is collapsed by default for an owner without accountant permissions', () => {
    access.accountant = false;
    const group = accountantGroup();
    expect(group?.collapsed).toBe(true);
    expect(group?.items).toEqual([]);
    expect(group?.onToggleCollapse).toBeTypeOf('function');
  });

  it('keeps the item of the page the person is on while collapsed', () => {
    access.accountant = false;
    route.pathname = '/weldbooks/fiscal-periods';
    expect(accountantGroup()?.items.map((i) => i.href)).toEqual(['/weldbooks/fiscal-periods']);
  });

  it('opens on toggle and remembers the choice', () => {
    access.accountant = false;
    const { result } = renderHook(() => useWeldbooksSidebarItems(true));
    const find = () =>
      result.current.adjust(MENU()).find((g) => g.group === en.navigation.moduleSidebar.groups.accountant)!;
    expect(find().collapsed).toBe(true);
    act(() => find().onToggleCollapse?.());
    expect(find().collapsed).toBe(false);
    expect(find().items.length).toBeGreaterThan(1);
    expect(localStorage.getItem('weldbooks:sidebar:accountant-collapsed')).toBe('0');
  });

  it('starts from the remembered choice, whatever the permissions say', () => {
    localStorage.setItem('weldbooks:sidebar:accountant-collapsed', '1');
    expect(accountantGroup()?.collapsed).toBe(true);
    access.accountant = false;
    localStorage.setItem('weldbooks:sidebar:accountant-collapsed', '0');
    expect(accountantGroup()?.collapsed).toBe(false);
  });

  it('still works when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    access.accountant = false;
    expect(accountantGroup()?.collapsed).toBe(true);
    spy.mockRestore();
  });
});

describe('the processing view in the menu', () => {
  afterEach(() => {
    access.processing = false;
  });

  const bank = () => adjust().find((g) => g.group === en.navigation.moduleSidebar.groups.bank)!;

  beforeEach(() => {
    route.pathname = '/weldbooks';
    route.search = '';
    access.accountant = true;
    jurisdiction = known();
  });

  it('keeps the transaction list and the reconcile screen where the edition lacks the processing view', () => {
    access.processing = false;
    expect(bank().items.map((i) => i.href)).toContain('/weldbooks/banking/transactions');
    expect(bank().items.map((i) => i.href)).toContain('/weldbooks/banking/reconciliation');
  });

  it('opens the processing view from Transactions, active on both pages, and drops the reconcile item', () => {
    access.processing = true;
    const hrefs = bank().items.map((i) => i.href);
    expect(hrefs).toContain('/weldbooks/banking/process');
    expect(hrefs).not.toContain('/weldbooks/banking/transactions');
    expect(hrefs).not.toContain('/weldbooks/banking/reconciliation');
    const item = () => bank().items.find((i) => i.href === '/weldbooks/banking/process');
    expect(item()?.isActive).toBe(false);
    route.pathname = '/weldbooks/banking/process';
    expect(item()?.isActive).toBe(true);
    route.pathname = '/weldbooks/banking/transactions';
    expect(item()?.isActive).toBe(true);
  });
});

describe('the badges', () => {
  const item = (href: string) => adjust().flatMap((g) => g.items).find((i) => i.href === href);

  beforeEach(() => {
    route.pathname = '/weldbooks';
    route.search = '';
    jurisdiction = known();
    todo.summary = summary(
      { documents: { count: 4, amount: null }, bank_lines: { count: 12, amount: '221.00', currency: 'EUR' } },
      19,
    );
  });

  it('counts the total on To process, the documents on Inbox and the bank lines on Transactions', () => {
    expect(item('/weldbooks/to-process')).toMatchObject({ badge: '19', badgeLabel: '19 items to process' });
    expect(item('/weldbooks/documents')).toMatchObject({ badge: '4', badgeLabel: '4 documents in the inbox' });
    expect(item('/weldbooks/banking/transactions')).toMatchObject({ badge: '12', badgeLabel: '12 bank lines to process' });
  });

  it('puts no badge on any other item', () => {
    const badged = adjust()
      .flatMap((g) => g.items)
      .filter((i) => i.badge)
      .map((i) => i.href);
    expect(badged).toEqual(['/weldbooks/to-process', '/weldbooks/documents', '/weldbooks/banking/transactions']);
  });

  it('shows no badge for a count of zero, a kind the member cannot read, or a summary that is not there yet', () => {
    todo.summary = summary({ documents: { count: 0, amount: null } }, 0);
    expect(item('/weldbooks/to-process')?.badge).toBeUndefined();
    expect(item('/weldbooks/documents')?.badge).toBeUndefined();
    expect(item('/weldbooks/banking/transactions')?.badge).toBeUndefined();
    todo.summary = undefined;
    expect(item('/weldbooks/to-process')?.badge).toBeUndefined();
  });

  it('writes a large count as 99+', () => {
    todo.summary = summary({ bank_lines: { count: 340, amount: null } }, 340);
    expect(item('/weldbooks/to-process')?.badge).toBe('99+');
    expect(item('/weldbooks/banking/transactions')?.badgeLabel).toBe('340 bank lines to process');
  });
});

describe('the new-supplier form', () => {
  it('is the customers route with ?role=supplier', () => {
    expect(isSupplierContactForm('/weldbooks/customers/add', null)).toBe(false);
    expect(isSupplierContactForm('/weldbooks/customers/add', 'supplier')).toBe(true);
    expect(isSupplierContactForm('/weldbooks/customers', 'supplier')).toBe(false);
  });
});
