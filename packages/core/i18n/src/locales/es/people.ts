/**
 * People — identity layer for individuals (Companies/People refactor).
 * Replaces the legacy `crm.contacts` namespace once the new pages are wired.
 * Both stay valid in parallel during the transition.
 */
export const people = {
  title: 'Personas',
  person: 'Persona',
  people: 'Personas',

  // Identity
  firstName: 'Nombre',
  lastName: 'Apellidos',
  fullName: 'Nombre completo',
  displayName: 'Nombre para mostrar',
  dateOfBirth: 'Fecha de nacimiento',
  gender: 'Género',
  title2: 'Título', // `title` is reserved at the namespace root above
  department: 'Departamento',
  role: 'Cargo',

  // Contact info
  email: 'Correo electrónico',
  directPhone: 'Teléfono directo',
  mobilePhone: 'Móvil',
  extension: 'Extensión',
  linkedinUrl: 'LinkedIn',
  twitterHandle: 'Twitter',

  // Status / lifecycle
  status: 'Estado',
  lifecycleStage: 'Etapa del ciclo de vida',
  rating: 'Valoración',
  source: 'Fuente',

  // Flags
  isSupplier: 'Proveedor',
  isLead: 'Lead',
  isFavorite: 'Favorito',
  isDecisionMaker: 'Tomador de decisiones',
  isBillingContact: 'Contacto de facturación',
  isTechnicalContact: 'Contacto técnico',
  influenceLevel: 'Nivel de influencia',

  // Affiliation
  affiliatedWith: 'Afiliado a',
  primary: 'Principal',
  past: 'Anterior',

  // Empty / loading states
  notFound: 'Persona no encontrada',
  loading: 'Cargando personas…',
  emptyList: 'Aún no hay personas',

  // Actions
  actions: {
    create: 'Crear persona',
    edit: 'Editar persona',
    delete: 'Eliminar persona',
    openFullPage: 'Abrir página completa',
  },

  // Tabs
  tabs: {
    overview: 'Resumen',
    companies: 'Empresas',
    activity: 'Actividad',
    emails: 'Correos electrónicos',
    meetings: 'Reuniones',
    tickets: 'Tickets',
    notes: 'Notas',
  },

  // Filters
  filters: {
    all: 'Todas las personas',
    customers: 'Clientes',
    suppliers: 'Proveedores',
    leads: 'Leads',
  },

  // Quick-add dialog
  quickAdd: {
    title: 'Añadir persona',
    description: 'Crea una nueva persona. Puedes asociarla a una empresa después.',
    firstNamePlaceholder: 'Jane',
    lastNamePlaceholder: 'Doe',
    emailPlaceholder: 'jane@example.com',
    titlePlaceholder: 'VP of Engineering',
    phonePlaceholder: '+31 6 …',
    nameRequiredError: 'Proporciona al menos un nombre, apellidos o correo electrónico',
    markAsCustomer: 'Marcar como cliente',
  },
} as const;
