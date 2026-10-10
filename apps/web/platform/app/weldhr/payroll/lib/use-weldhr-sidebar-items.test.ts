import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useWeldhrSidebarItems } from './use-weldhr-sidebar-items';

let enabled = false;

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useHrPayrollFlag: () => ({ enabled, isLoading: false }),
}));

const Icon = () => null;
const groups: MenuGroupProps[] = [
  { group: 'People', items: [{ title: 'Employees', href: '/weldhr/employees', icon: Icon }] },
  {
    group: 'Payroll',
    items: [
      { title: 'Overview', href: '/weldhr/payroll', icon: Icon, permission: 'payroll:read' },
      { title: 'Settings', href: '/weldhr/payroll/settings', icon: Icon, permission: 'payroll:manage' },
    ],
  },
];

describe('useWeldhrSidebarItems', () => {
  it('hides the payroll group while the weldhr-payroll flag is off', () => {
    enabled = false;
    const { result } = renderHook(() => useWeldhrSidebarItems(true));

    expect(result.current.adjust(groups).map((group) => group.group)).toEqual(['People']);
  });

  it('keeps every item when the flag is on', () => {
    enabled = true;
    const { result } = renderHook(() => useWeldhrSidebarItems(true));

    expect(result.current.adjust(groups)).toEqual(groups);
  });

  it('leaves other modules alone', () => {
    enabled = false;
    const { result } = renderHook(() => useWeldhrSidebarItems(false));

    expect(result.current.adjust(groups)).toEqual(groups);
  });
});
