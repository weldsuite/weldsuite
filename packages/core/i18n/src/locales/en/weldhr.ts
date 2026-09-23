/**
 * WeldHR — employee operations and the workforce portal.
 *
 * Split per area so each screen group owns its own file:
 *   weldhr-people.ts       dashboard, employees, org chart, client accounts
 *   weldhr-time.ts         on/offboarding, attendance, shifts, leave
 *   weldhr-performance.ts  coaching, evaluations, KPIs, milestones
 *   weldhr-admin.ts        settings and the workforce portal
 * Shared labels (status chips, pickers, generic actions) live here.
 */
import { weldhrAdmin } from './weldhr-admin';
import { weldhrPeople } from './weldhr-people';
import { weldhrPerformance } from './weldhr-performance';
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
    remove: 'Remove',
    close: 'Close',
    confirm: 'Confirm',
    search: 'Search',
    all: 'All',
    none: 'None',
    yes: 'Yes',
    no: 'No',
    employee: 'Employee',
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
    confirmDelete: 'Delete this item? This cannot be undone.',
    sharedWithClient: 'Shared with client',
    sharedWithClientHint: 'Visible to the client in the workforce portal.',
    internalOnly: 'Internal only',
    importCsv: 'Import CSV',
    importResult: '{created} added, {updated} updated',
    importErrors: '{count} rows could not be imported',
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
    leave: {
      pending: 'Pending',
      approved: 'Approved',
      rejected: 'Rejected',
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
  ...weldhrPerformance,
  ...weldhrAdmin,
};
