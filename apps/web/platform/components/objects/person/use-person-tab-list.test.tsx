import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const env = vi.hoisted(() => ({ contactPage: true, canReadInvoices: true }));

vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => feature === 'books-contact-page' && env.contactPage,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => permission === 'invoices:read' && env.canReadInvoices }),
}));

import { usePersonTabList } from './use-person-tab-list';
import { PERSON_TABS, personTabs } from './person-tabs';

beforeEach(() => {
  env.contactPage = true;
  env.canReadInvoices = true;
});

describe('the Finance tab of the person panel', () => {
  it('is in the tab set, and left out unless it applies', () => {
    expect(PERSON_TABS.some((tab) => tab.id === 'finance')).toBe(true);
    expect(personTabs(true)).toHaveLength(PERSON_TABS.length);
    expect(personTabs(false).some((tab) => tab.id === 'finance')).toBe(false);
    expect(personTabs(false)).toHaveLength(PERSON_TABS.length - 1);
  });

  it('sits before the audit log, which stays last', () => {
    const ids = personTabs(true).map((tab) => tab.id);
    expect(ids.indexOf('finance')).toBeLessThan(ids.indexOf('audit'));
    expect(ids.at(-1)).toBe('audit');
  });

  it('joins the list, labelled in the UI language, on an edition with the contact page', () => {
    const { result } = renderHook(() => usePersonTabList());
    expect(result.current.find((tab) => tab.id === 'finance')?.label).toBe('Finance');
  });

  it('is left out on Global, where there is no contact page', () => {
    env.contactPage = false;
    const { result } = renderHook(() => usePersonTabList());
    expect(result.current.some((tab) => tab.id === 'finance')).toBe(false);
  });

  it('is left out for a member who cannot read invoices', () => {
    env.canReadInvoices = false;
    const { result } = renderHook(() => usePersonTabList());
    expect(result.current.some((tab) => tab.id === 'finance')).toBe(false);
  });

  it('keeps the same list between renders', () => {
    const { result, rerender } = renderHook(() => usePersonTabList());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
