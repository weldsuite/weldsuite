import { useCallback, useEffect, useState } from 'react';
import { usePermissions } from '@weldsuite/permissions/react';
import type { MenuGroupProps, MenuItemProps } from '@/components/app-sidebar-layout';
import { menuPermissionAllows } from '@/components/layout/menu-permission';
import { useMyHr, useMyHrOverview } from '@/hooks/queries/use-weldhr-queries';
import { usePathname } from '@/lib/router';
import { MY_HR_GROUP_KEY, MY_HR_PATHS } from '../access';
import { useMyPayroll } from '../me/components/my-payroll';

const COLLAPSED_STORAGE_KEY = 'weldhr:sidebar:my-hr-collapsed';
const PAYROLL_PREFIX = '/weldhr/payroll';

export interface WeldhrMenuState {
  /** Whether the member has an active employee record; undefined while that is still loading. */
  hasEmployee: boolean | undefined;
  /** The weldhr-payroll flag; while it is off (or loading) the payroll team pages are hidden. */
  payrollEnabled: boolean;
  /** Whether My HR → Payroll applies to this member (flag on, and on payroll or has payslips). */
  myPayroll: boolean;
  collapsed: boolean;
  pathname: string;
  /**
   * Open onboarding tasks, coaching + evaluations waiting for an acknowledgement,
   * and missing payroll details + unsigned tax forms.
   */
  counts: { tasks: number; reviews: number; payroll: number };
  /** The sidebar's own check: owner, or holds the permission. */
  canSee: (permission: string) => boolean;
  onToggleCollapse: () => void;
}

/** The My HR item the current page belongs to: the longest href that matches. */
function activeItem(items: MenuItemProps[], pathname: string): MenuItemProps | undefined {
  return items
    .filter((item) => pathname === item.href || pathname.startsWith(item.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

const COUNTED: Partial<Record<string, keyof WeldhrMenuState['counts']>> = {
  [MY_HR_PATHS.tasks]: 'tasks',
  [MY_HR_PATHS.reviews]: 'reviews',
  [MY_HR_PATHS.payroll]: 'payroll',
};

/** Puts each count on its My HR item as a badge; a zero count shows none. */
function withCounts(items: MenuItemProps[], counts: WeldhrMenuState['counts']): MenuItemProps[] {
  return items.map((item) => {
    const key = COUNTED[item.href];
    const count = key ? counts[key] : 0;
    return count > 0 ? { ...item, badge: String(count) } : item;
  });
}

/** The HR team's payroll pages (`/weldhr/payroll` and below); My HR → Payroll is not one of them. */
function isPayrollPage(href: string): boolean {
  return href === PAYROLL_PREFIX || href.startsWith(PAYROLL_PREFIX + '/');
}

/**
 * Shapes the static WeldHR menu (MODULE_CONFIGS.weldhr) for the member:
 *
 * - An employee (My HR, no team view) gets the My HR group and nothing else.
 *   Without an employee record that group is just Overview, which explains
 *   that HR still has to add them.
 * - Someone with the team view gets My HR on top, collapsible, but only once
 *   it is known they have an employee record of their own. An owner or admin
 *   who isn't on the staff list never sees it.
 * - Collapsed, the group keeps showing the page you're on.
 * - Payroll follows the weldhr-payroll flag: the team's payroll pages are
 *   hidden while it is off, and My HR → Payroll also needs the member to be
 *   on payroll.
 */
export function adjustWeldhrMenu(groups: MenuGroupProps[], state: WeldhrMenuState): MenuGroupProps[] {
  const menu = state.payrollEnabled
    ? groups
    : groups
        .map((group) => ({ ...group, items: group.items.filter((item) => !isPayrollPage(item.href)) }))
        .filter((group) => group.items.length > 0);

  const myHrGroup = menu.find((group) => group.groupKey === MY_HR_GROUP_KEY);
  if (!myHrGroup) return menu;
  const myHr = { ...myHrGroup, items: myHrGroup.items.filter((item) => item.href !== MY_HR_PATHS.payroll || state.myPayroll) };
  const teamGroups = menu.filter((group) => group !== myHrGroup);

  const allowed = (item: MenuItemProps) => menuPermissionAllows(item.permission, state.canSee);
  if (!myHr.items.some(allowed)) return teamGroups;
  const hasTeamView = teamGroups.some((group) => group.items.some(allowed));

  if (!hasTeamView) {
    const items =
      state.hasEmployee === false
        ? myHr.items.filter((item) => item.href === MY_HR_PATHS.overview)
        : withCounts(myHr.items, state.counts);
    return [{ ...myHr, items }, ...teamGroups];
  }

  if (state.hasEmployee !== true) return teamGroups;

  const items = withCounts(myHr.items, state.counts);
  const current = activeItem(items, state.pathname);
  return [
    {
      ...myHr,
      items: state.collapsed ? (current ? [current] : []) : items,
      collapsed: state.collapsed,
      onToggleCollapse: state.onToggleCollapse,
    },
    ...teamGroups,
  ];
}

/** The remembered collapse state of My HR; expanded when storage is unavailable. */
function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remembers the collapse state for the next visit, where storage allows. */
function writeCollapsed(collapsed: boolean) {
  try {
    globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage blocked (private window): the toggle still works for this visit.
  }
}

/**
 * Loads what `adjustWeldhrMenu` needs (employee record, counts, payroll, the
 * collapse state) and returns the `adjust` the sidebar applies to the static
 * WeldHR menu. Outside WeldHR (`enabled` false) it leaves the menu alone.
 */
export function useWeldhrSidebarItems(enabled: boolean) {
  const pathname = usePathname();
  const { can, isOwner } = usePermissions();
  const canSelf = enabled && (isOwner || can('employees:self'));
  const self = useMyHr({ enabled: canSelf });
  const employee = self.data?.employee;
  const overview = useMyHrOverview({ enabled: canSelf && Boolean(employee) });
  const payroll = useMyPayroll(canSelf && Boolean(employee));
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const onToggleCollapse = useCallback(() => setCollapsed((previous) => !previous), []);
  useEffect(() => writeCollapsed(collapsed), [collapsed]);

  let hasEmployee: boolean | undefined;
  if (self.data) hasEmployee = Boolean(employee);
  else if (self.isError) hasEmployee = false;

  const tasks = overview.data?.openTasks ?? 0;
  const reviews = overview.data ? overview.data.toAcknowledge.coaching + overview.data.toAcknowledge.evaluations : 0;

  const adjust = useCallback(
    (groups: MenuGroupProps[]): MenuGroupProps[] => {
      if (!enabled) return groups;
      return adjustWeldhrMenu(groups, {
        hasEmployee,
        payrollEnabled: payroll.flagOn,
        myPayroll: payroll.show,
        collapsed,
        pathname,
        counts: { tasks, reviews, payroll: payroll.todo },
        canSee: (permission) => isOwner || can(permission),
        onToggleCollapse,
      });
    },
    [enabled, hasEmployee, payroll.flagOn, payroll.show, payroll.todo, collapsed, pathname, tasks, reviews, isOwner, can, onToggleCollapse],
  );

  return { adjust };
}
