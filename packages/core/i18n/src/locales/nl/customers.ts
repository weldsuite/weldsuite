export const customers = {
    title: 'Klanten',
    customer: 'Klant',
    company: 'Bedrijf',
    contactPerson: 'Contactpersoon',
    email: 'E-mail',
    phone: 'Telefoon',
    address: 'Adres',
    city: 'Stad',
    state: 'Provincie',
    postalCode: 'Postcode',
    country: 'Land',
    taxId: 'BTW-nummer',
    website: 'Website',
    creditLimit: 'Kredietlimiet',
    paymentTerms: 'Betalingsvoorwaarden',
    notes: 'Notities',

    // Customer types
    types: {
      b2b: 'Bedrijf (B2B)',
      b2c: 'Particulier (B2C)',
      business: 'Bedrijf',
      individual: 'Particulier',
    },

    // Tabs
    tabs: {
      general: 'Algemeen',
      contacts: 'Contactpersonen',
      address: 'Adres',
      financial: 'Financieel',
    },

    // Sections
    sections: {
      customerType: 'Klanttype',
      customerTypeDesc: 'Selecteer of dit een zakelijke of particuliere klant is',
      generalInformation: 'Algemene Informatie',
      addressInformation: 'Adresinformatie',
      financialSettings: 'Financiële Instellingen',
      contactManagement: 'Contactpersonen',
      contactManagementDesc: 'Beheer contactpersonen voor dit bedrijf',
    },

    // Form labels
    companyName: 'Bedrijfsnaam',
    vatNumber: 'BTW-nummer',
    chamberOfCommerce: 'Kamer van Koophandel',
    registrationNumber: 'Registratienummer',
    firstName: 'Voornaam',
    lastName: 'Achternaam',
    emailAddress: 'E-mailadres',
    phoneNumber: 'Telefoonnummer',
    addressLine1: 'Adresregel 1',
    addressLine2: 'Adresregel 2',
    stateProvince: 'Provincie/Staat',
    creditLimitLabel: 'Kredietlimiet',
    paymentTermsDays: 'Betalingstermijn (Dagen)',
    jobTitle: 'Functietitel',
    department: 'Afdeling',
    mobile: 'Mobiel',
    primaryContact: 'Primair Contact',
    isActive: 'Actief',

    // Placeholders
    placeholders: {
      selectCustomerType: 'Selecteer klanttype',
      companyName: 'Bedrijfsnaam',
      vatNumber: 'BTW-nummer',
      registrationNumber: 'Registratienummer',
      firstName: 'Voornaam',
      lastName: 'Achternaam',
      emailAddress: 'E-mailadres',
      phoneNumber: 'Telefoonnummer',
      addressLine1: 'Straatnaam en huisnummer',
      addressLine2: 'Appartement, suite, etc.',
      city: 'Stad',
      stateProvince: 'Provincie of Staat',
      postalCode: 'Postcode',
      country: 'Land',
      notes: 'Aanvullende notities',
      creditLimit: '0,00',
      paymentTerms: '30',
      jobTitle: 'Functietitel',
      department: 'Afdeling',
    },

    // Descriptions
    descriptions: {
      setActive: 'Stel in of deze klant actief is',
      creditLimit: 'Maximaal toegestaan krediet voor deze klant',
      paymentTerms: 'Aantal dagen voor betaling',
      primaryContact: 'Stel in als hoofdcontactpersoon',
    },

    // Contact management
    contacts: {
      contact: 'Contact',
      addContact: 'Contactpersoon Toevoegen',
      removeContact: 'Contactpersoon Verwijderen',
      primary: 'Primair',
      noContacts: 'Nog geen contactpersonen toegevoegd. Klik op "Contactpersoon Toevoegen" om een contactpersoon toe te voegen.',
    },

    // Buttons
    buttons: {
      cancel: 'Annuleren',
      save: 'Opslaan',
      saving: 'Opslaan...',
      createCustomer: 'Klant Aanmaken',
      updateCustomer: 'Klant Bijwerken',
    },

    // Validation
    validation: {
      invalidEmail: 'Ongeldig e-mailadres',
      firstNameRequired: 'Voornaam is verplicht',
      lastNameRequired: 'Achternaam is verplicht',
      fillRequired: 'Vul alle verplichte velden in',
    },

    actions: {
      newCustomer: 'Nieuwe klant',
      editCustomer: 'Klant bewerken',
      deleteCustomer: 'Klant verwijderen',
      mergeCustomers: 'Klanten samenvoegen',
      viewHistory: 'Historie bekijken',
      sendStatement: 'Overzicht verzenden'
    },

    messages: {
      customerCreated: 'Klant aangemaakt',
      customerCreatedDesc: 'De klant is succesvol aangemaakt.',
      customerUpdated: 'Klant bijgewerkt',
      customerUpdatedDesc: 'De klant is succesvol bijgewerkt.',
      customerDeleted: 'Klant succesvol verwijderd',
      cannotDeleteWithInvoices: 'Kan klant met bestaande facturen niet verwijderen',
      error: 'Fout',
      failedToSave: 'Klant opslaan mislukt. Probeer het opnieuw.',
      validationError: 'Validatiefout',
    }
  };
