import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const env = vi.hoisted(() => ({
  offered: true,
  canRead: true,
  /** Edition feature `books-contact-page`, and the right to read invoices. */
  contactPage: true,
  canReadInvoices: true,
}));

vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => (feature === 'books-contact-page' ? env.contactPage : env.offered),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({
    can: (permission: string) =>
      (permission === 'companies:read' && env.canRead) || (permission === 'invoices:read' && env.canReadInvoices),
  }),
}));

import { useCompanyTabList } from './use-company-tab-list';
import { COMPANY_TABS, canShowBuyers, canShowFinance, companyTabs } from './company-tabs';

beforeEach(() => {
  env.offered = true;
  env.canRead = true;
  env.contactPage = true;
  env.canReadInvoices = true;
});

describe('the Buyers tab', () => {
  it('needs both WeldCommerce on this edition and the right to read companies', () => {
    expect(canShowBuyers(true, true)).toBe(true);
    expect(canShowBuyers(false, true)).toBe(false);
    expect(canShowBuyers(true, false)).toBe(false);
  });

  it('is the last of the company tabs, and left out when it does not apply', () => {
    expect(COMPANY_TABS.at(-1)?.id).toBe('buyers');
    expect(companyTabs(true, true)).toHaveLength(COMPANY_TABS.length);
    expect(companyTabs(false, true).some((tab) => tab.id === 'buyers')).toBe(false);
    expect(companyTabs(false, true)).toHaveLength(COMPANY_TABS.length - 1);
  });
});

describe('the Finance tab', () => {
  it('needs the WeldBooks contact page on this edition and the right to read invoices', () => {
    expect(canShowFinance(true, true)).toBe(true);
    expect(canShowFinance(false, true)).toBe(false);
    expect(canShowFinance(true, false)).toBe(false);
  });

  it('is left out of the tabs unless it applies', () => {
    expect(companyTabs(true).some((tab) => tab.id === 'finance')).toBe(false);
    expect(companyTabs(true, true).some((tab) => tab.id === 'finance')).toBe(true);
  });

  it('joins the list, labelled in the UI language, on an edition with the contact page', () => {
    const { result } = renderHook(() => useCompanyTabList());
    expect(result.current.find((tab) => tab.id === 'finance')?.label).toBe('Finance');
  });

  it('is left out on Global, where there is no contact page', () => {
    env.contactPage = false;
    const { result } = renderHook(() => useCompanyTabList());
    expect(result.current.some((tab) => tab.id === 'finance')).toBe(false);
  });

  it('is left out for a member who cannot read invoices', () => {
    env.canReadInvoices = false;
    const { result } = renderHook(() => useCompanyTabList());
    expect(result.current.some((tab) => tab.id === 'finance')).toBe(false);
  });
});

describe('useCompanyTabList', () => {
  it('adds the Buyers tab, labelled in the UI language, where WeldCommerce is offered and companies are readable', () => {
    const { result } = renderHook(() => useCompanyTabList());
    expect(result.current.find((tab) => tab.id === 'buyers')?.label).toBe('Buyers');
  });

  it('leaves it out on an edition without WeldCommerce', () => {
    env.offered = false;
    const { result } = renderHook(() => useCompanyTabList());
    expect(result.current.some((tab) => tab.id === 'buyers')).toBe(false);
  });

  it('leaves it out for a member who cannot read companies', () => {
    env.canRead = false;
    const { result } = renderHook(() => useCompanyTabList());
    expect(result.current.some((tab) => tab.id === 'buyers')).toBe(false);
  });

  it('keeps the same list between renders', () => {
    const { result, rerender } = renderHook(() => useCompanyTabList());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
