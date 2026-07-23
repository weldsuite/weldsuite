export const companies = {
  title: 'Entreprises',
  company: 'Entreprise',
  companies: 'Entreprises',

  name: 'Nom',
  tradingName: "Nom commercial",
  displayName: "Nom d'affichage",
  vatNumber: 'Numéro de TVA',
  registrationNumber: "Numéro d'enregistrement",
  industry: 'Secteur',
  employeeCount: 'Effectif',
  annualRevenue: 'Chiffre annuel',
  website: 'Site web',

  email: 'E-mail',
  phone: 'Téléphone',
  mobile: 'Mobile',
  primaryAddress: 'Adresse principale',

  status: 'Statut',
  lifecycleStage: 'Étape du cycle de vie',
  segment: 'Segment',
  rating: 'Évaluation',
  source: 'Source',

  isSupplier: 'Fournisseur',
  isLead: 'Prospect',
  isFavorite: 'Favori',

  notFound: 'Entreprise introuvable',
  loading: 'Chargement…',
  emptyList: 'Aucune entreprise',

  actions: {
    create: 'Créer une entreprise',
    edit: "Modifier l'entreprise",
    delete: "Supprimer l'entreprise",
    archive: 'Archiver',
    unarchive: 'Désarchiver',
    openFullPage: 'Ouvrir en pleine page',
  },

  tabs: {
    overview: "Aperçu",
    people: 'Personnes',
    activity: 'Activité',
    deals: 'Affaires',
    invoices: 'Factures',
    orders: 'Commandes',
    tickets: 'Tickets',
    notes: 'Notes',
    documents: 'Documents',
  },

  filters: {
    all: 'Toutes',
    customers: 'Clients',
    suppliers: 'Fournisseurs',
    leads: 'Prospects',
  },

  quickAdd: {
    title: 'Ajouter une entreprise',
    description: 'Créez une nouvelle entreprise.',
    namePlaceholder: 'Acme SARL',
    emailPlaceholder: 'info@acme.fr',
    websitePlaceholder: 'acme.fr',
    industryPlaceholder: 'SaaS',
    markAsCustomer: 'Marquer comme client',
  },
} as const;
