export const people = {
  title: 'Personnes',
  person: 'Personne',
  people: 'Personnes',

  firstName: 'Prénom',
  lastName: 'Nom',
  fullName: 'Nom complet',
  displayName: "Nom d'affichage",
  dateOfBirth: 'Date de naissance',
  gender: 'Genre',
  title2: 'Titre',
  department: 'Département',
  role: 'Rôle',

  email: 'E-mail',
  directPhone: 'Téléphone direct',
  mobilePhone: 'Mobile',
  extension: 'Poste',
  linkedinUrl: 'LinkedIn',
  twitterHandle: 'Twitter',

  status: 'Statut',
  lifecycleStage: 'Étape du cycle de vie',
  rating: 'Évaluation',
  source: 'Source',

  isSupplier: 'Fournisseur',
  isLead: 'Prospect',
  isFavorite: 'Favori',
  isDecisionMaker: 'Décideur',
  isBillingContact: 'Contact facturation',
  isTechnicalContact: 'Contact technique',
  influenceLevel: "Niveau d'influence",

  affiliatedWith: 'Affilié à',
  primary: 'Principal',
  past: 'Passé',

  notFound: 'Personne introuvable',
  loading: 'Chargement…',
  emptyList: 'Aucune personne',

  actions: {
    create: 'Créer une personne',
    edit: 'Modifier',
    delete: 'Supprimer',
    openFullPage: 'Ouvrir en pleine page',
  },

  tabs: {
    overview: 'Aperçu',
    companies: 'Entreprises',
    activity: 'Activité',
    emails: 'E-mails',
    meetings: 'Réunions',
    tickets: 'Tickets',
    notes: 'Notes',
  },

  filters: {
    all: 'Toutes',
    customers: 'Clients',
    suppliers: 'Fournisseurs',
    leads: 'Prospects',
  },

  quickAdd: {
    title: 'Ajouter une personne',
    description: 'Créez une nouvelle personne.',
    firstNamePlaceholder: 'Jeanne',
    lastNamePlaceholder: 'Dupont',
    emailPlaceholder: 'jeanne@exemple.fr',
    titlePlaceholder: 'VP Ingénierie',
    phonePlaceholder: '+33 6 …',
    nameRequiredError: 'Indiquez au moins un prénom, un nom ou un e-mail',
    markAsCustomer: 'Marquer comme client',
  },
} as const;
