/**
 * Lists — kind-scoped (company XOR person) groupings.
 */
export const lists = {
  title: 'Listas',
  list: 'Lista',
  lists: 'Listas',

  companyLists: 'Listas de empresas',
  peopleLists: 'Listas de personas',

  description: 'Agrupaciones personalizadas de empresas o personas: VIPs, prospectos, segmentos, etc.',
  members: 'Miembros',
  member: 'Miembro',

  // Empty
  emptyForCompanies: 'Aún no hay listas. Crea una para agrupar empresas.',
  emptyForPeople: 'Aún no hay listas. Crea una para agrupar personas.',
  emptyMembers: 'Aún no hay miembros.',

  // Actions
  actions: {
    create: 'Nueva lista',
    delete: 'Eliminar lista',
    addMembers: 'Añadir miembros',
    removeMember: 'Quitar de la lista',
  },

  // Dialog
  dialog: {
    newCompanyListTitle: 'Nueva lista de empresas',
    newPersonListTitle: 'Nueva lista de personas',
    namePlaceholder: 'Clientes VIP',
    create: 'Crear lista',
    cancel: 'Cancelar',
  },

  // Confirmations
  confirmDelete: '¿Eliminar la lista "{name}"?',

  // Toasts
  toasts: {
    created: 'Lista creada',
    deleted: 'Lista eliminada',
    memberAdded: 'Añadido a la lista',
    memberRemoved: 'Quitado de la lista',
  },
} as const;
