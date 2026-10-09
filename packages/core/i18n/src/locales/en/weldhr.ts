/**
 * WeldHR — employee operations and the workforce portal.
 *
 * Split per area so each screen group owns its own file:
 *   weldhr-people.ts       dashboard, employees
 *   weldhr-time.ts         attendance, shifts, leave
 *   weldhr-declarations.ts expense declarations
 *   weldhr-admin.ts        settings and the workforce portal
 *   weldhr-self.ts         My HR, the employee self-service page
 * Shared labels (status chips, pickers, generic actions) live here.
 */
import { weldhrAdmin } from './weldhr-admin';
import { weldhrDeclarations } from './weldhr-declarations';
import { weldhrPeople } from './weldhr-people';
import { weldhrSelf } from './weldhr-self';
import { weldhrTime } from './weldhr-time';

export const weldhr = {
  title: 'WeldHR',

  common: {
    selectEmployee: 'Select an employee',
    selectClient: 'Select a client account',
    selectContact: 'Select a contact',
    noResults: 'No results',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    create: 'Create',
    add: 'Add',
    edit: 'Edit',
    delete: 'Delete',
    search: 'Search',
    all: 'All',
    none: 'None',
    yes: 'Yes',
    no: 'No',
    client: 'Client account',
    date: 'Date',
    from: 'From',
    to: 'To',
    status: 'Status',
    notes: 'Notes',
    actions: 'Actions',
    loadFailed: 'Could not load this data.',
    saveFailed: 'Could not save your changes.',
    deleteFailed: 'Could not delete this item.',
    internalOnly: 'Internal only',
    noPermission: 'You do not have permission to see this.',
  },

  status: {
    employee: {
      onboarding: 'Onboarding',
      active: 'Active',
      on_leave: 'On leave',
      offboarding: 'Offboarding',
      terminated: 'Left',
    },
    employmentType: {
      full_time: 'Full-time',
      part_time: 'Part-time',
      contractor: 'Contractor',
      intern: 'Intern',
      temporary: 'Temporary',
    },
    attendance: {
      present: 'Present',
      late: 'Late',
      absent: 'Absent',
      excused: 'Excused',
      remote: 'Remote',
      half_day: 'Half day',
    },
    absence: {
      ongoing: 'Sick',
      completed: 'Recovered',
    },
    leave: {
      pending: 'Pending',
      approved: 'Approved',
      rejected: 'Rejected',
      cancelled: 'Cancelled',
    },
    declaration: {
      pending: 'Pending',
      approved: 'Approved',
      rejected: 'Rejected',
      paid: 'Paid',
      cancelled: 'Cancelled',
    },
    coaching: {
      open: 'Open',
      acknowledged: 'Acknowledged',
      closed: 'Closed',
    },
    coachingCategory: {
      performance: 'Performance',
      quality: 'Quality',
      behavior: 'Behaviour',
      attendance: 'Attendance',
      development: 'Development',
      recognition: 'Recognition',
    },
    visibility: {
      internal: 'Internal only',
      employee: 'Employee',
      client: 'Employee and client',
    },
    evaluation: {
      draft: 'Draft',
      submitted: 'Submitted',
      acknowledged: 'Acknowledged',
    },
    milestone: {
      planned: 'Planned',
      in_progress: 'In progress',
      achieved: 'Achieved',
      missed: 'Missed',
    },
    milestoneType: {
      goal: 'Goal',
      milestone: 'Milestone',
      certification: 'Certification',
    },
    checklist: {
      in_progress: 'In progress',
      completed: 'Completed',
      cancelled: 'Cancelled',
    },
    checklistKind: {
      onboarding: 'Onboarding',
      offboarding: 'Offboarding',
    },
    assigneeRole: {
      hr: 'HR',
      manager: 'Manager',
      it: 'IT',
      employee: 'Employee',
      other: 'Other',
    },
    portalAccess: {
      invited: 'Invited',
      active: 'Active',
      revoked: 'Revoked',
    },
    kpiUnit: {
      number: 'Number',
      percent: 'Percent',
      seconds: 'Seconds',
      minutes: 'Minutes',
      currency: 'Currency',
    },
    kpiDirection: {
      higher_better: 'Higher is better',
      lower_better: 'Lower is better',
    },
  },

  ...weldhrPeople,
  ...weldhrTime,
  ...weldhrDeclarations,
  ...weldhrAdmin,
  ...weldhrSelf,
};
