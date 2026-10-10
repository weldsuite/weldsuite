import { useCallback } from 'react';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { useHrPayrollFlag } from '@/hooks/queries/use-weldhr-payroll-queries';

const PAYROLL_PREFIX = '/weldhr/payroll';

/**
 * Adjusts the static WeldHR menu (MODULE_CONFIGS.weldhr) to the
 * `weldhr-payroll` flag: while the flag is off (or still loading) every
 * `/weldhr/payroll/*` item is hidden, and a group left without items is
 * dropped. The permission filter (`payroll:read`, `payroll:manage`) runs
 * afterwards in the sidebar like for every other item.
 */
export function useWeldhrSidebarItems(enabled: boolean) {
  const flag = useHrPayrollFlag();
  const payrollOn = flag.enabled;

  const adjust = useCallback(
    (groups: MenuGroupProps[]): MenuGroupProps[] => {
      if (!enabled || payrollOn) return groups;
      return groups
        .map((group) => ({ ...group, items: group.items.filter((item) => !item.href.startsWith(PAYROLL_PREFIX)) }))
        .filter((group) => group.items.length > 0);
    },
    [enabled, payrollOn],
  );

  return { adjust };
}
