/**
 * Who sees which half of the app. Mirrors the platform's
 * `apps/web/platform/app/weldhr/access.ts`: My HR needs `employees:self`;
 * the team views (everyone's shifts, hours and absences, approvals, the
 * directory) each need the permission behind their endpoint.
 *
 * This is UX only; hr-api checks every request again.
 */

import { hasAppPermission, type PermissionSubject } from '@weldsuite/permissions';

/** Permissions are per app; this app checks them as WeldHR. */
export const APP_CODE = 'weldhr';

export interface HrAccess {
  /** My HR: the member's own record, time off, expenses, payslips. */
  self: boolean;
  /** Approve or reject leave requests. */
  approveLeave: boolean;
  /** Approve or reject expense declarations (and mark them paid). */
  approveExpenses: boolean;
  /** Who is clocked in or on leave today. */
  teamToday: boolean;
  /** Everyone's shifts and hours (Schedule → Team, Timesheet → Timesheets / Clocked in). */
  attendance: boolean;
  /** Everyone's approved leave (Absence → Absences). */
  leave: boolean;
  /** Who is reported sick (everyone's sick reports). */
  sickToday: boolean;
  /** The employee directory. */
  directory: boolean;
  /** Any of the team permissions. */
  team: boolean;
}

export const NO_ACCESS: HrAccess = {
  self: false,
  approveLeave: false,
  approveExpenses: false,
  teamToday: false,
  attendance: false,
  leave: false,
  sickToday: false,
  directory: false,
  team: false,
};

/** The permissions `GET /api/weldhr/dashboard` accepts (any one of them). */
const DASHBOARD_PERMISSIONS = ['employees:read', 'attendance:read', 'leave:read', 'coaching:read', 'evaluations:read'];

export function resolveAccess(subject: PermissionSubject, appEnforced: boolean): HrAccess {
  const app = appEnforced ? APP_CODE : null;
  const can = (permission: string) => hasAppPermission(subject, permission, app);

  const approveLeave = can('leave:read') && can('leave:approve');
  const approveExpenses = can('declarations:read') && can('declarations:approve');
  const teamToday = DASHBOARD_PERMISSIONS.some(can);
  const sickToday = can('absences:read');
  const directory = can('employees:read');

  return {
    self: can('employees:self'),
    approveLeave,
    approveExpenses,
    teamToday,
    attendance: can('attendance:read'),
    leave: can('leave:read'),
    sickToday,
    directory,
    team: approveLeave || approveExpenses || teamToday || sickToday || directory,
  };
}
