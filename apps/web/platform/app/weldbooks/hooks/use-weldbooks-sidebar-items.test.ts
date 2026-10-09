import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import type { CurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { DEFAULT_TERMINOLOGY, NO_JURISDICTION_FEATURES } from '@/lib/weldbooks/jurisdiction';
import { useWeldbooksSidebarItems } from './use-weldbooks-sidebar-items';

let jurisdiction: Partial<CurrentJurisdiction>;

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      navigation: {
        moduleSidebar: {
          weldbooks: {
            vendors: 'Vendors',
            creditMemos: 'Credit Memos',
            taxNav: { vat: 'VAT Returns', gst: 'GST Returns', sales_tax: 'Sales Tax' },
          },
        },
      },
    },
  }),
}));

vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => jurisdiction,
}));

const icon = () => null;
const item = (href: string) => ({ title: href, href, icon });

const MENU = [
  { group: 'Purchases', items: [item('/weldbooks/bills'), item('/weldbooks/payment-runs')] },
  { group: 'Accounting', items: [item('/weldbooks/journal'), item('/weldbooks/vat'), item('/weldbooks/fixed-assets')] },
  { group: 'Tax', items: [item('/weldbooks/sales-tax'), item('/weldbooks/form-1099'), item('/weldbooks/tax-calendar')] },
  { group: 'Contacts', items: [item('/weldbooks/suppliers')] },
] as unknown as MenuGroupProps[];

function hrefs(groups: MenuGroupProps[]): string[] {
  return groups.flatMap((g) => g.items.map((i) => i.href));
}

function adjust() {
  const { result } = renderHook(() => useWeldbooksSidebarItems(true));
  return result.current.adjust(MENU);
}

describe('useWeldbooksSidebarItems', () => {
  beforeEach(() => {
    jurisdiction = { features: NO_JURISDICTION_FEATURES, terminology: DEFAULT_TERMINOLOGY, isResolved: false, isError: false };
  });

  it('hides every gated item until the jurisdiction is known, and drops the empty tax group', () => {
    const groups = adjust();
    expect(hrefs(groups)).toEqual(['/weldbooks/bills', '/weldbooks/journal', '/weldbooks/fixed-assets', '/weldbooks/suppliers']);
    expect(groups.map((g) => g.group)).not.toContain('Tax');
  });

  it('shows the US screens and vendor wording for a US entity, without the VAT return', () => {
    jurisdiction = {
      features: { ...NO_JURISDICTION_FEATURES, salesTax: true, form1099: true },
      terminology: { ...DEFAULT_TERMINOLOGY, tax: 'sales_tax', supplier: 'vendor', creditNote: 'credit_memo' },
      isResolved: true,
      isError: false,
    };
    const groups = adjust();
    expect(hrefs(groups)).toEqual([
      '/weldbooks/bills', '/weldbooks/payment-runs',
      '/weldbooks/journal', '/weldbooks/fixed-assets',
      '/weldbooks/sales-tax', '/weldbooks/form-1099', '/weldbooks/tax-calendar',
      '/weldbooks/suppliers',
    ]);
    expect(groups.at(-1)?.items[0]?.title).toBe('Vendors');
  });

  it('shows the VAT return and no US screens for a Dutch entity', () => {
    jurisdiction = {
      features: { ...NO_JURISDICTION_FEATURES, vatReturn: true, icp: true },
      terminology: DEFAULT_TERMINOLOGY,
      isResolved: true,
      isError: false,
    };
    const groups = adjust();
    expect(hrefs(groups)).toEqual(['/weldbooks/bills', '/weldbooks/journal', '/weldbooks/vat', '/weldbooks/fixed-assets', '/weldbooks/suppliers']);
  });

  it('keeps gated items hidden when the jurisdictions fail to load', () => {
    jurisdiction = { features: NO_JURISDICTION_FEATURES, terminology: DEFAULT_TERMINOLOGY, isResolved: false, isError: true };
    expect(hrefs(adjust())).not.toContain('/weldbooks/sales-tax');
  });
});
