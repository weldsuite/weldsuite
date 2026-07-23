export const lists = {
  title: 'Listes',
  list: 'Liste',
  lists: 'Listes',

  companyLists: "Listes d'entreprises",
  peopleLists: 'Listes de personnes',

  description: "Regroupements personnalisés d'entreprises ou de personnes.",
  members: 'Membres',
  member: 'Membre',

  emptyForCompanies: 'Aucune liste. Créez-en une pour regrouper des entreprises.',
  emptyForPeople: 'Aucune liste. Créez-en une pour regrouper des personnes.',
  emptyMembers: 'Aucun membre.',

  actions: {
    create: 'Nouvelle liste',
    delete: 'Supprimer la liste',
    addMembers: 'Ajouter des membres',
    removeMember: 'Retirer de la liste',
  },

  dialog: {
    newCompanyListTitle: "Nouvelle liste d'entreprises",
    newPersonListTitle: 'Nouvelle liste de personnes',
    namePlaceholder: 'Clients VIP',
    create: 'Créer la liste',
    cancel: 'Annuler',
  },

  confirmDelete: 'Supprimer la liste "{name}" ?',

  toasts: {
    created: 'Liste créée',
    deleted: 'Liste supprimée',
    memberAdded: 'Ajouté à la liste',
    memberRemoved: 'Retiré de la liste',
  },
} as const;
