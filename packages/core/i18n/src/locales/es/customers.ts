export const customers = {
    title: 'Clientes',
    customer: 'Cliente',
    company: 'Empresa',
    contactPerson: 'Persona de contacto',
    email: 'Correo electrónico',
    phone: 'Teléfono',
    address: 'Dirección',
    city: 'Ciudad',
    state: 'Provincia',
    postalCode: 'Código postal',
    country: 'País',
    taxId: 'NIF/CIF',
    website: 'Sitio web',
    creditLimit: 'Límite de crédito',
    paymentTerms: 'Condiciones de pago',
    notes: 'Notas',

    // Customer types
    types: {
      b2b: 'Empresa (B2B)',
      b2c: 'Particular (B2C)',
      business: 'Empresa',
      individual: 'Particular',
    },

    // Tabs
    tabs: {
      general: 'General',
      contacts: 'Contactos',
      address: 'Dirección',
      financial: 'Financiero',
    },

    // Sections
    sections: {
      customerType: 'Tipo de cliente',
      customerTypeDesc: 'Selecciona si es una empresa o un cliente particular',
      generalInformation: 'Información general',
      addressInformation: 'Información de dirección',
      financialSettings: 'Configuración financiera',
      contactManagement: 'Contactos',
      contactManagementDesc: 'Gestiona las personas de contacto de esta empresa',
    },

    // Form labels
    companyName: 'Nombre de la empresa',
    vatNumber: 'Número de IVA',
    chamberOfCommerce: 'Cámara de comercio',
    registrationNumber: 'Número de registro',
    firstName: 'Nombre',
    lastName: 'Apellidos',
    emailAddress: 'Dirección de correo electrónico',
    phoneNumber: 'Número de teléfono',
    addressLine1: 'Dirección línea 1',
    addressLine2: 'Dirección línea 2',
    stateProvince: 'Provincia/Estado',
    creditLimitLabel: 'Límite de crédito',
    paymentTermsDays: 'Condiciones de pago (días)',
    jobTitle: 'Cargo',
    department: 'Departamento',
    mobile: 'Móvil',
    primaryContact: 'Contacto principal',
    isActive: 'Activo',

    // Placeholders
    placeholders: {
      selectCustomerType: 'Selecciona el tipo de cliente',
      companyName: 'Nombre de la empresa',
      vatNumber: 'Número de IVA',
      registrationNumber: 'Número de registro',
      firstName: 'Nombre',
      lastName: 'Apellidos',
      emailAddress: 'Dirección de correo electrónico',
      phoneNumber: 'Número de teléfono',
      addressLine1: 'Dirección',
      addressLine2: 'Apartamento, piso, etc.',
      city: 'Ciudad',
      stateProvince: 'Provincia o estado',
      postalCode: 'Código postal',
      country: 'País',
      notes: 'Notas adicionales',
      creditLimit: '0.00',
      paymentTerms: '30',
      jobTitle: 'Cargo',
      department: 'Departamento',
    },

    // Descriptions
    descriptions: {
      setActive: 'Indica si este cliente está activo',
      creditLimit: 'Crédito máximo permitido para este cliente',
      paymentTerms: 'Número de días para el pago',
      primaryContact: 'Establecer como contacto principal',
    },

    // Contact management
    contacts: {
      contact: 'Contacto',
      addContact: 'Añadir contacto',
      removeContact: 'Eliminar contacto',
      primary: 'Principal',
      noContacts: 'No se han añadido contactos. Haz clic en "Añadir contacto" para añadir una persona de contacto.',
    },

    // Buttons
    buttons: {
      cancel: 'Cancelar',
      save: 'Guardar',
      saving: 'Guardando...',
      createCustomer: 'Crear cliente',
      updateCustomer: 'Actualizar cliente',
    },

    // Validation
    validation: {
      invalidEmail: 'Dirección de correo electrónico no válida',
      firstNameRequired: 'El nombre es obligatorio',
      lastNameRequired: 'Los apellidos son obligatorios',
      fillRequired: 'Por favor, rellena todos los campos obligatorios',
    },

    actions: {
      newCustomer: 'Nuevo cliente',
      editCustomer: 'Editar cliente',
      deleteCustomer: 'Eliminar cliente',
      mergeCustomers: 'Combinar clientes',
      viewHistory: 'Ver historial',
      sendStatement: 'Enviar extracto'
    },

    messages: {
      customerCreated: 'Cliente creado',
      customerCreatedDesc: 'El cliente se ha creado correctamente.',
      customerUpdated: 'Cliente actualizado',
      customerUpdatedDesc: 'El cliente se ha actualizado correctamente.',
      customerDeleted: 'Cliente eliminado correctamente',
      cannotDeleteWithInvoices: 'No se puede eliminar un cliente con facturas existentes',
      error: 'Error',
      failedToSave: 'No se pudo guardar el cliente. Por favor, inténtalo de nuevo.',
      validationError: 'Error de validación',
    }
  };
