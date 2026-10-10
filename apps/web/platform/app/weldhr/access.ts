/**
 * Who sees which half of WeldHR.
 *
 * My HR (`/weldhr/me/*`) is the member's own record and needs `employees:self`.
 * Everything else is the HR team's view of everyone, gated per page on that
 * object's permissions. Someone with both sees both, My HR on top.
 */

/** The permissions `GET /api/weldhr/dashboard` accepts (any one of them). */
export const HR_DASHBOARD_PERMISSIONS = [
  'employees:read',
  'attendance:read',
  'leave:read',
  'coaching:read',
  'evaluations:read',
] as const;

/** `groupKey` of the My HR sidebar group, so the sidebar hook can find it. */
export const MY_HR_GROUP_KEY = 'weldhr-me';

export const MY_HR_PATHS = {
  overview: '/weldhr/me',
  timeOff: '/weldhr/me/time-off',
  expenses: '/weldhr/me/expenses',
  schedule: '/weldhr/me/schedule',
  payroll: '/weldhr/me/payroll',
  tasks: '/weldhr/me/tasks',
  reviews: '/weldhr/me/reviews',
} as const;

export type MyHrPath = (typeof MY_HR_PATHS)[keyof typeof MY_HR_PATHS];

/** Where the old `/weldhr/me?tab=…` links go now that each tab is its own page. */
export const LEGACY_MY_HR_TABS: Partial<Record<string, MyHrPath>> = {
  overview: MY_HR_PATHS.overview,
  leave: MY_HR_PATHS.timeOff,
  declarations: MY_HR_PATHS.expenses,
  attendance: MY_HR_PATHS.schedule,
  payroll: MY_HR_PATHS.payroll,
  tasks: MY_HR_PATHS.tasks,
  reviews: MY_HR_PATHS.reviews,
  goals: MY_HR_PATHS.reviews,
};
