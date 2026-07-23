/**
 * Lists — kind-scoped (company XOR person) groupings.
 */
export const lists = {
  title: 'Lists',
  list: 'List',
  lists: 'Lists',

  companyLists: 'Company Lists',
  peopleLists: 'People Lists',

  description: 'Custom groupings of companies or people — VIPs, prospects, segments, etc.',
  members: 'Members',
  member: 'Member',

  // Empty
  emptyForCompanies: 'No lists yet. Create one to group companies together.',
  emptyForPeople: 'No lists yet. Create one to group people together.',
  emptyMembers: 'No members yet.',

  // Actions
  actions: {
    create: 'New list',
    delete: 'Delete list',
    addMembers: 'Add members',
    removeMember: 'Remove from list',
  },

  // Dialog
  dialog: {
    newCompanyListTitle: 'New company list',
    newPersonListTitle: 'New people list',
    namePlaceholder: 'VIP customers',
    create: 'Create list',
    cancel: 'Cancel',
  },

  // Confirmations
  confirmDelete: 'Delete list "{name}"?',

  // Toasts
  toasts: {
    created: 'List created',
    deleted: 'List deleted',
    memberAdded: 'Added to list',
    memberRemoved: 'Removed from list',
  },
} as const;
