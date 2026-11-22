import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const env = vi.hoisted(() => ({ offered: true, canRead: true }));

vi.mock('@/lib/edition', () => ({ isFeatureAvailable: () => env.offered }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissionsMaybe: () => ({ can: (permission: string) => permission === 'companies:read' && env.canRead }),
}));

import { useCompanyTabList } from './use-company-tab-list';
import { COMPANY_TABS, canShowBuyers, companyTabs } from './company-tabs';

beforeEach(() => {
  env.offered = true;
  env.canRead = true;
});

describe('the Buyers tab', () => {
  it('needs both WeldCommerce on this edition and the right to read companies', () => {
    expect(canShowBuyers(true, true)).toBe(true);
    expect(canShowBuyers(false, true)).toBe(false);
    expect(canShowBuyers(true, false)).toBe(false);
  });

  it('is the last of the company tabs, and left out when it does not apply', () => {
    expect(COMPANY_TABS.at(-1)?.id).toBe('buyers');
    expect(companyTabs(true)).toHaveLength(COMPANY_TABS.length);
    expect(companyTabs(false).some((tab) => tab.id === 'buyers')).toBe(false);
    expect(companyTabs(false)).toHaveLength(COMPANY_TABS.length - 1);
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
