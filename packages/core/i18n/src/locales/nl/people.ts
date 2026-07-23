export const people = {
  title: 'Personen',
  person: 'Persoon',
  people: 'Personen',

  firstName: 'Voornaam',
  lastName: 'Achternaam',
  fullName: 'Volledige naam',
  displayName: 'Weergavenaam',
  dateOfBirth: 'Geboortedatum',
  gender: 'Geslacht',
  title2: 'Functie',
  department: 'Afdeling',
  role: 'Rol',

  email: 'E-mail',
  directPhone: 'Direct telefoonnummer',
  mobilePhone: 'Mobiel',
  extension: 'Toestel',
  linkedinUrl: 'LinkedIn',
  twitterHandle: 'Twitter',

  status: 'Status',
  lifecycleStage: 'Levenscyclusfase',
  rating: 'Beoordeling',
  source: 'Bron',

  isSupplier: 'Leverancier',
  isLead: 'Lead',
  isFavorite: 'Favoriet',
  isDecisionMaker: 'Beslisser',
  isBillingContact: 'Factuurcontact',
  isTechnicalContact: 'Technisch contact',
  influenceLevel: 'Invloedsniveau',

  affiliatedWith: 'Verbonden met',
  primary: 'Primair',
  past: 'Verleden',

  notFound: 'Persoon niet gevonden',
  loading: 'Personen laden…',
  emptyList: 'Nog geen personen',

  actions: {
    create: 'Persoon toevoegen',
    edit: 'Persoon bewerken',
    delete: 'Persoon verwijderen',
    openFullPage: 'Volledige pagina openen',
  },

  tabs: {
    overview: 'Overzicht',
    companies: 'Bedrijven',
    activity: 'Activiteit',
    emails: 'E-mails',
    meetings: 'Vergaderingen',
    tickets: 'Tickets',
    notes: 'Notities',
  },

  filters: {
    all: 'Alle personen',
    customers: 'Klanten',
    suppliers: 'Leveranciers',
    leads: 'Leads',
  },

  quickAdd: {
    title: 'Persoon toevoegen',
    description: 'Maak een nieuwe persoon aan. Je kunt ze daarna aan een bedrijf koppelen.',
    firstNamePlaceholder: 'Jan',
    lastNamePlaceholder: 'Janssen',
    emailPlaceholder: 'jan@voorbeeld.nl',
    titlePlaceholder: 'VP Engineering',
    phonePlaceholder: '+31 6 …',
    nameRequiredError: 'Voer ten minste een voornaam, achternaam of e-mailadres in',
    markAsCustomer: 'Markeren als klant',
  },
} as const;
