/**
 * Companies — identity layer for organisations (Companies/People refactor).
 * Mirrors the legacy `customers` namespace shape so existing components can
 * be ported one at a time. The legacy `customers` keys stay valid alongside.
 */
export const companies = {
  title: 'Companies',
  company: 'Company',
  companies: 'Companies',

  // Top-line attributes
  name: 'Name',
  tradingName: 'Trading name',
  displayName: 'Display name',
  vatNumber: 'VAT number',
  registrationNumber: 'Registration number',
  industry: 'Industry',
  employeeCount: 'Employees',
  annualRevenue: 'Annual revenue',
  website: 'Website',

  // Contact info
  email: 'Email',
  phone: 'Phone',
  mobile: 'Mobile',
  primaryAddress: 'Primary address',

  // Status / lifecycle
  status: 'Status',
  lifecycleStage: 'Lifecycle stage',
  segment: 'Segment',
  rating: 'Rating',
  source: 'Source',

  // Flags
  isSupplier: 'Supplier',
  isLead: 'Lead',
  isFavorite: 'Favorite',

  // Empty / loading states
  notFound: 'Company not found',
  loading: 'Loading companies…',
  emptyList: 'No companies yet',

  // Actions
  actions: {
    create: 'Create company',
    edit: 'Edit company',
    delete: 'Delete company',
    archive: 'Archive',
    unarchive: 'Unarchive',
    openFullPage: 'Open full page',
  },

  // Tabs
  tabs: {
    overview: 'Overview',
    people: 'People',
    activity: 'Activity',
    deals: 'Deals',
    invoices: 'Invoices',
    orders: 'Orders',
    tickets: 'Tickets',
    notes: 'Notes',
    documents: 'Documents',
  },

  // Filters
  filters: {
    all: 'All companies',
    customers: 'Customers',
    suppliers: 'Suppliers',
    leads: 'Leads',
  },

  // Quick-add dialog
  quickAdd: {
    title: 'Add company',
    description: 'Create a new company. You can edit more fields after saving.',
    namePlaceholder: 'Acme Corp',
    emailPlaceholder: 'info@acme.com',
    websitePlaceholder: 'acme.com',
    industryPlaceholder: 'SaaS',
    markAsCustomer: 'Mark as customer',
  },
} as const;
