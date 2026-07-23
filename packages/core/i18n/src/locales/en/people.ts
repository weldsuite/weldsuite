/**
 * People — identity layer for individuals (Companies/People refactor).
 * Replaces the legacy `crm.contacts` namespace once the new pages are wired.
 * Both stay valid in parallel during the transition.
 */
export const people = {
  title: 'People',
  person: 'Person',
  people: 'People',

  // Identity
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  displayName: 'Display name',
  dateOfBirth: 'Date of birth',
  gender: 'Gender',
  title2: 'Title', // `title` is reserved at the namespace root above
  department: 'Department',
  role: 'Role',

  // Contact info
  email: 'Email',
  directPhone: 'Direct phone',
  mobilePhone: 'Mobile',
  extension: 'Extension',
  linkedinUrl: 'LinkedIn',
  twitterHandle: 'Twitter',

  // Status / lifecycle
  status: 'Status',
  lifecycleStage: 'Lifecycle stage',
  rating: 'Rating',
  source: 'Source',

  // Flags
  isSupplier: 'Supplier',
  isLead: 'Lead',
  isFavorite: 'Favorite',
  isDecisionMaker: 'Decision maker',
  isBillingContact: 'Billing contact',
  isTechnicalContact: 'Technical contact',
  influenceLevel: 'Influence level',

  // Affiliation
  affiliatedWith: 'Affiliated with',
  primary: 'Primary',
  past: 'Past',

  // Empty / loading states
  notFound: 'Person not found',
  loading: 'Loading people…',
  emptyList: 'No people yet',

  // Actions
  actions: {
    create: 'Create person',
    edit: 'Edit person',
    delete: 'Delete person',
    openFullPage: 'Open full page',
  },

  // Tabs
  tabs: {
    overview: 'Overview',
    companies: 'Companies',
    activity: 'Activity',
    emails: 'Emails',
    meetings: 'Meetings',
    tickets: 'Tickets',
    notes: 'Notes',
  },

  // Filters
  filters: {
    all: 'All people',
    customers: 'Customers',
    suppliers: 'Suppliers',
    leads: 'Leads',
  },

  // Quick-add dialog
  quickAdd: {
    title: 'Add person',
    description: 'Create a new person. You can attach them to a company afterwards.',
    firstNamePlaceholder: 'Jane',
    lastNamePlaceholder: 'Doe',
    emailPlaceholder: 'jane@example.com',
    titlePlaceholder: 'VP of Engineering',
    phonePlaceholder: '+31 6 …',
    nameRequiredError: 'Provide at least a first name, last name, or email',
    markAsCustomer: 'Mark as customer',
  },
} as const;
