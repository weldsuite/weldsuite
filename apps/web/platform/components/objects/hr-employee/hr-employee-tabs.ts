import {
  Banknote,
  ChartNoAxesGantt,
  Clock,
  Network,
  Plane,
  ShieldCheck,
} from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/** Object-panel type of a WeldHR employee, the `stack=` value of its deep links. */
export const HR_EMPLOYEE_PANEL_TYPE = 'hr_employee';

/** The tabs of the employee panel; the ids are the `tab` values old `/weldhr/employees/:id?tab=` links carry. */
export type HrEmployeeTabId = 'overview' | 'reports' | 'personal' | 'attendance' | 'leave' | 'payroll';

export const HR_EMPLOYEE_TAB_ICONS: Record<HrEmployeeTabId, ObjectPanelTabDescriptor['icon']> = {
  overview: ChartNoAxesGantt,
  reports: Network,
  personal: ShieldCheck,
  attendance: Clock,
  leave: Plane,
  payroll: Banknote,
};

/** Employee status → the colour of its chip (`STATUS_STYLE_MAP` / `LinkedRecordStatus`). */
export const HR_EMPLOYEE_STATUS_TONE = {
  onboarding: 'blue',
  active: 'green',
  on_leave: 'amber',
  offboarding: 'amber',
  terminated: 'gray',
} as const satisfies Record<'onboarding' | 'active' | 'on_leave' | 'offboarding' | 'terminated', string>;

export function isHrEmployeeTabId(value: string | undefined): value is HrEmployeeTabId {
  return !!value && Object.hasOwn(HR_EMPLOYEE_TAB_ICONS, value);
}

/**
 * Where the old employee page URL now lands: the employee list with the
 * employee's panel open in fullscreen, on the tab the link asked for.
 */
export function hrEmployeePanelHref(employeeId: string, tab?: string): string {
  const parts = [HR_EMPLOYEE_PANEL_TYPE, encodeURIComponent(employeeId), 'fullscreen'];
  if (isHrEmployeeTabId(tab)) parts.push(`tab=${tab}`);
  return `/weldhr/employees?stack=${parts.join(':')}`;
}
