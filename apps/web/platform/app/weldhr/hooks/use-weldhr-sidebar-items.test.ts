import { describe, expect, it, vi } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type { MenuGroupProps } from '@/components/app-sidebar-layout';
import { menuPermissionAllows } from '@/components/layout/menu-permission';
import { MODULE_CONFIGS } from '@/components/layout/module-sidebar-configs';
import { adjustWeldhrMenu, type WeldhrMenuState } from './use-weldhr-sidebar-items';

const MENU = MODULE_CONFIGS.weldhr!.getMenuItems(en);

const EMPLOYEE = ['employees:self'];
const HR_MANAGER = [
  'employees:self', 'employees:read', 'employees:manage', 'attendance:read', 'leave:read',
  'declarations:read', 'absences:read', 'coaching:read', 'evaluations:read', 'payroll:read', 'payroll:manage',
];

function state(permissions: string[], overrides: Partial<WeldhrMenuState> = {}): WeldhrMenuState {
  return {
    hasEmployee: true,
    payrollEnabled: false,
    myPayroll: false,
    collapsed: false,
    pathname: '/weldhr',
    counts: { tasks: 0, reviews: 0, payroll: 0 },
    canSee: (permission) => permissions.includes(permission),
    onToggleCollapse: vi.fn(),
    ...overrides,
  };
}

/** What the sidebar renders: adjust, then the sidebar's own permission filter and empty-group drop. */
function sidebar(permissions: string[], overrides: Partial<WeldhrMenuState> = {}): MenuGroupProps[] {
  const s = state(permissions, overrides);
  return adjustWeldhrMenu(MENU, s)
    .map((group) => ({ ...group, items: group.items.filter((item) => menuPermissionAllows(item.permission, s.canSee)) }))
    .filter((group) => group.items.length > 0 || group.collapsed);
}

const groupNames = (groups: MenuGroupProps[]) => groups.map((group) => group.group);
const hrefs = (group: MenuGroupProps | undefined) => group?.items.map((item) => item.href) ?? [];

const MY_HR_HREFS = [
  '/weldhr/me',
  '/weldhr/me/time-off',
  '/weldhr/me/expenses',
  '/weldhr/me/schedule',
  '/weldhr/me/tasks',
  '/weldhr/me/reviews',
];

describe('WeldHR sidebar', () => {
  it('gives an employee My HR and nothing else, not even the dashboard', () => {
    const groups = sidebar(EMPLOYEE);
    expect(groupNames(groups)).toEqual(['My HR']);
    expect(hrefs(groups[0])).toEqual(MY_HR_HREFS);
    expect(groups[0]!.onToggleCollapse).toBeUndefined();
  });

  it('leaves an employee without a record only the overview, which says HR has to add them', () => {
    expect(hrefs(sidebar(EMPLOYEE, { hasEmployee: false })[0])).toEqual(['/weldhr/me']);
  });

  it('gives an HR manager My HR on top, collapsible, above the team view', () => {
    const groups = sidebar(HR_MANAGER);
    expect(groupNames(groups)).toEqual(['My HR', 'Team', 'Time', 'Expenses', 'Settings']);
    expect(hrefs(groups[0])).toEqual(MY_HR_HREFS);
    expect(groups[0]!.onToggleCollapse).toBeTypeOf('function');
    expect(hrefs(groups[2])).toEqual(['/weldhr/attendance', '/weldhr/absenteeism', '/weldhr/leave']);
  });

  it('hides My HR from HR without an employee record, and while that is still loading', () => {
    expect(groupNames(sidebar(HR_MANAGER, { hasEmployee: false }))).not.toContain('My HR');
    expect(groupNames(sidebar(HR_MANAGER, { hasEmployee: undefined }))).not.toContain('My HR');
  });

  it('keeps only the current page under a collapsed My HR', () => {
    const onTimeOff = sidebar(HR_MANAGER, { collapsed: true, pathname: '/weldhr/me/time-off' });
    expect(onTimeOff[0]!.collapsed).toBe(true);
    expect(hrefs(onTimeOff[0])).toEqual(['/weldhr/me/time-off']);

    const elsewhere = sidebar(HR_MANAGER, { collapsed: true, pathname: '/weldhr/leave' });
    expect(elsewhere[0]!.group).toBe('My HR');
    expect(hrefs(elsewhere[0])).toEqual([]);
  });

  it('shows the dashboard to anyone with one of the permissions the dashboard endpoint accepts', () => {
    const team = sidebar(['employees:self', 'coaching:read']).find((group) => group.group === 'Team');
    expect(hrefs(team)).toEqual(['/weldhr']);
  });

  it('puts open tasks and reviews to acknowledge on their items', () => {
    const myHr = sidebar(EMPLOYEE, { counts: { tasks: 2, reviews: 0, payroll: 0 } })[0]!;
    const badge = (href: string) => myHr.items.find((item) => item.href === href)?.badge;
    expect(badge('/weldhr/me/tasks')).toBe('2');
    expect(badge('/weldhr/me/reviews')).toBeUndefined();
  });

  it('hides the payroll team pages while the weldhr-payroll flag is off', () => {
    expect(groupNames(sidebar(HR_MANAGER))).not.toContain('Payroll');
    const payroll = sidebar(HR_MANAGER, { payrollEnabled: true }).find((group) => group.group === 'Payroll');
    expect(hrefs(payroll)[0]).toBe('/weldhr/payroll');
  });

  it('adds My HR → Payroll, with what is still to do, only for a member on payroll', () => {
    expect(hrefs(sidebar(EMPLOYEE, { payrollEnabled: true })[0])).not.toContain('/weldhr/me/payroll');

    const myHr = sidebar(EMPLOYEE, { payrollEnabled: true, myPayroll: true, counts: { tasks: 0, reviews: 0, payroll: 3 } })[0]!;
    expect(hrefs(myHr)).toEqual([...MY_HR_HREFS.slice(0, 4), '/weldhr/me/payroll', ...MY_HR_HREFS.slice(4)]);
    expect(myHr.items.find((item) => item.href === '/weldhr/me/payroll')?.badge).toBe('3');
  });

  it('shows nothing of My HR to someone without employees:self', () => {
    expect(groupNames(sidebar(['employees:read']))).toEqual(['Team']);
  });
});
