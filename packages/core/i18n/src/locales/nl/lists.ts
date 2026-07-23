export const lists = {
  title: 'Lijsten',
  list: 'Lijst',
  lists: 'Lijsten',

  companyLists: 'Bedrijfslijsten',
  peopleLists: 'Personenlijsten',

  description: 'Aangepaste groepen van bedrijven of personen — VIPs, prospects, segmenten, enz.',
  members: 'Leden',
  member: 'Lid',

  emptyForCompanies: 'Nog geen lijsten. Maak er één aan om bedrijven te groeperen.',
  emptyForPeople: 'Nog geen lijsten. Maak er één aan om personen te groeperen.',
  emptyMembers: 'Nog geen leden.',

  actions: {
    create: 'Nieuwe lijst',
    delete: 'Lijst verwijderen',
    addMembers: 'Leden toevoegen',
    removeMember: 'Verwijderen uit lijst',
  },

  dialog: {
    newCompanyListTitle: 'Nieuwe bedrijfslijst',
    newPersonListTitle: 'Nieuwe personenlijst',
    namePlaceholder: 'VIP-klanten',
    create: 'Lijst aanmaken',
    cancel: 'Annuleren',
  },

  confirmDelete: 'Lijst "{name}" verwijderen?',

  toasts: {
    created: 'Lijst aangemaakt',
    deleted: 'Lijst verwijderd',
    memberAdded: 'Toegevoegd aan lijst',
    memberRemoved: 'Verwijderd uit lijst',
  },
} as const;
