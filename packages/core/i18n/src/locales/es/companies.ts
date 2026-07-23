/**
 * Companies — identity layer for organisations (Companies/People refactor).
 * Mirrors the legacy `customers` namespace shape so existing components can
 * be ported one at a time. The legacy `customers` keys stay valid alongside.
 */
export const companies = {
  title: 'Empresas',
  company: 'Empresa',
  companies: 'Empresas',

  // Top-line attributes
  name: 'Nombre',
  tradingName: 'Nombre comercial',
  displayName: 'Nombre para mostrar',
  vatNumber: 'Número de IVA',
  registrationNumber: 'Número de registro',
  industry: 'Sector',
  employeeCount: 'Empleados',
  annualRevenue: 'Ingresos anuales',
  website: 'Sitio web',

  // Contact info
  email: 'Correo electrónico',
  phone: 'Teléfono',
  mobile: 'Móvil',
  primaryAddress: 'Dirección principal',

  // Status / lifecycle
  status: 'Estado',
  lifecycleStage: 'Etapa del ciclo de vida',
  segment: 'Segmento',
  rating: 'Valoración',
  source: 'Fuente',

  // Flags
  isSupplier: 'Proveedor',
  isLead: 'Lead',
  isFavorite: 'Favorito',

  // Empty / loading states
  notFound: 'Empresa no encontrada',
  loading: 'Cargando empresas…',
  emptyList: 'Aún no hay empresas',

  // Actions
  actions: {
    create: 'Crear empresa',
    edit: 'Editar empresa',
    delete: 'Eliminar empresa',
    archive: 'Archivar',
    unarchive: 'Desarchivar',
    openFullPage: 'Abrir página completa',
  },

  // Tabs
  tabs: {
    overview: 'Resumen',
    people: 'Personas',
    activity: 'Actividad',
    deals: 'Negocios',
    invoices: 'Facturas',
    orders: 'Pedidos',
    tickets: 'Tickets',
    notes: 'Notas',
    documents: 'Documentos',
  },

  // Filters
  filters: {
    all: 'Todas las empresas',
    customers: 'Clientes',
    suppliers: 'Proveedores',
    leads: 'Leads',
  },

  // Quick-add dialog
  quickAdd: {
    title: 'Añadir empresa',
    description: 'Crea una nueva empresa. Puedes editar más campos después de guardar.',
    namePlaceholder: 'Acme Corp',
    emailPlaceholder: 'info@acme.com',
    websitePlaceholder: 'acme.com',
    industryPlaceholder: 'SaaS',
    markAsCustomer: 'Marcar como cliente',
  },
} as const;
