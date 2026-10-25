/**
 * WeldHR — admin screens. Composed into `weldhr` by ./weldhr.ts.
 */
export const weldhrAdmin = {
  settings: {
    title: 'WeldHR settings',
    subtitle: 'Departments, leave types and what employees can do in My HR.',
    tabs: {
      departments: 'Departments',
      leaveTypes: 'Leave types',
      selfService: 'Self-service',
    },

    selfService: {
      title: 'My HR self-service',
      description: 'What employees can do for themselves in My HR. Reporting sick is always possible.',
      clockIn: 'Employees can clock in and out',
      leaveRequests: 'Employees can request leave',
      declarations: 'Employees can submit expense declarations',
      saved: 'Self-service settings saved',
    },

    departments: {
      subtitle: 'Org chart departments, each with an optional parent and head.',
      add: 'Add department',
      addTitle: 'Add department',
      editTitle: 'Edit department',
      name: 'Name',
      description: 'Description',
      parent: 'Parent department',
      head: 'Head of department',
      headAssigned: 'Assigned',
      color: 'Colour',
      employeeCount: 'Employees',
      emptyTitle: 'No departments yet',
      emptyDescription: 'Add your first department to start organising the directory.',
      deleteTitle: 'Delete department?',
      deleteDescription: 'Delete "{name}"? Employees in this department keep their assignment but lose the department link.',
      deleteMovesChildren: 'Its sub-departments ({count}) move under "{parent}".',
      deleteMovesChildrenTop: 'Its sub-departments ({count}) become top-level departments.',
      nameTaken: 'A department with this name already exists.',
    },

    leaveTypes: {
      subtitle: 'Leave categories, their default allowance and whether they need approval.',
      add: 'Add leave type',
      addTitle: 'Add leave type',
      editTitle: 'Edit leave type',
      name: 'Name',
      color: 'Colour',
      paid: 'Paid',
      requiresApproval: 'Requires approval',
      allowance: 'Default allowance',
      allowanceHint: 'Leave empty for an unlimited allowance.',
      blockOverAllowance: 'Block requests over the allowance',
      blockOverAllowanceHint:
        'When on, a request longer than what is left of the allowance cannot be submitted or approved. When off, HR and the employee only see a warning.',
      blocksOverAllowance: 'No going over',
      unlimited: 'Unlimited',
      daysPerYear: '{count} day/year',
      daysPerYearPlural: '{count} days/year',
      active: 'Active',
      inactive: 'Inactive',
      includeInactive: 'Include inactive',
      archivedInstead: '"{name}" has requests on record, so it was archived instead of deleted.',
      emptyTitle: 'No leave types yet',
      emptyDescription: 'Add a leave type such as holiday or sick leave to start tracking requests.',
      deleteTitle: 'Delete leave type?',
      deleteDescription: 'Delete "{name}"? If it has requests on record it will be archived instead.',
    },
  },
};
