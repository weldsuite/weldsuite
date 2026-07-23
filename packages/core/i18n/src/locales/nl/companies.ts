export const companies = {
  title: 'Bedrijven',
  company: 'Bedrijf',
  companies: 'Bedrijven',

  name: 'Naam',
  tradingName: 'Handelsnaam',
  displayName: 'Weergavenaam',
  vatNumber: 'BTW-nummer',
  registrationNumber: 'KvK-nummer',
  industry: 'Branche',
  employeeCount: 'Aantal medewerkers',
  annualRevenue: 'Jaaromzet',
  website: 'Website',

  email: 'E-mail',
  phone: 'Telefoon',
  mobile: 'Mobiel',
  primaryAddress: 'Primair adres',

  status: 'Status',
  lifecycleStage: 'Levenscyclusfase',
  segment: 'Segment',
  rating: 'Beoordeling',
  source: 'Bron',

  isSupplier: 'Leverancier',
  isLead: 'Lead',
  isFavorite: 'Favoriet',

  notFound: 'Bedrijf niet gevonden',
  loading: 'Bedrijven laden…',
  emptyList: 'Nog geen bedrijven',

  actions: {
    create: 'Bedrijf toevoegen',
    edit: 'Bedrijf bewerken',
    delete: 'Bedrijf verwijderen',
    archive: 'Archiveren',
    unarchive: 'Uit archief halen',
    openFullPage: 'Volledige pagina openen',
  },

  tabs: {
    overview: 'Overzicht',
    people: 'Personen',
    activity: 'Activiteit',
    deals: 'Deals',
    invoices: 'Facturen',
    orders: 'Bestellingen',
    tickets: 'Tickets',
    notes: 'Notities',
    documents: 'Documenten',
  },

  filters: {
    all: 'Alle bedrijven',
    customers: 'Klanten',
    suppliers: 'Leveranciers',
    leads: 'Leads',
  },

  quickAdd: {
    title: 'Bedrijf toevoegen',
    description: 'Maak een nieuw bedrijf aan. Je kunt meer velden bewerken na het opslaan.',
    namePlaceholder: 'Acme BV',
    emailPlaceholder: 'info@acme.nl',
    websitePlaceholder: 'acme.nl',
    industryPlaceholder: 'SaaS',
    markAsCustomer: 'Markeren als klant',
  },
} as const;
