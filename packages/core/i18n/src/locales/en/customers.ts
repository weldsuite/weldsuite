export const customers = {
    title: 'Customers',
    customer: 'Customer',
    company: 'Company',
    contactPerson: 'Contact Person',
    email: 'Email',
    phone: 'Phone',
    address: 'Address',
    city: 'City',
    state: 'State',
    postalCode: 'Postal Code',
    country: 'Country',
    taxId: 'Tax ID',
    website: 'Website',
    creditLimit: 'Credit Limit',
    paymentTerms: 'Payment Terms',
    notes: 'Notes',

    // Customer types
    types: {
      b2b: 'Business (B2B)',
      b2c: 'Individual (B2C)',
      business: 'Business',
      individual: 'Individual',
    },

    // Tabs
    tabs: {
      general: 'General',
      contacts: 'Contacts',
      address: 'Address',
      financial: 'Financial',
    },

    // Sections
    sections: {
      customerType: 'Customer Type',
      customerTypeDesc: 'Select whether this is a business or individual customer',
      generalInformation: 'General Information',
      addressInformation: 'Address Information',
      financialSettings: 'Financial Settings',
      contactManagement: 'Contacts',
      contactManagementDesc: 'Manage contact persons for this company',
    },

    // Form labels
    companyName: 'Company Name',
    vatNumber: 'VAT Number',
    chamberOfCommerce: 'Chamber of Commerce',
    registrationNumber: 'Registration Number',
    firstName: 'First Name',
    lastName: 'Last Name',
    emailAddress: 'Email Address',
    phoneNumber: 'Phone Number',
    addressLine1: 'Address Line 1',
    addressLine2: 'Address Line 2',
    stateProvince: 'State/Province',
    creditLimitLabel: 'Credit Limit',
    paymentTermsDays: 'Payment Terms (Days)',
    jobTitle: 'Job Title',
    department: 'Department',
    mobile: 'Mobile',
    primaryContact: 'Primary Contact',
    isActive: 'Active',

    // Placeholders
    placeholders: {
      selectCustomerType: 'Select customer type',
      companyName: 'Company name',
      vatNumber: 'VAT number',
      registrationNumber: 'Registration number',
      firstName: 'First name',
      lastName: 'Last name',
      emailAddress: 'Email address',
      phoneNumber: 'Phone number',
      addressLine1: 'Street address',
      addressLine2: 'Apartment, suite, etc.',
      city: 'City',
      stateProvince: 'State or Province',
      postalCode: 'Postal code',
      country: 'Country',
      notes: 'Additional notes',
      creditLimit: '0.00',
      paymentTerms: '30',
      jobTitle: 'Job title',
      department: 'Department',
    },

    // Descriptions
    descriptions: {
      setActive: 'Set whether this customer is active',
      creditLimit: 'Maximum credit allowed for this customer',
      paymentTerms: 'Number of days for payment',
      primaryContact: 'Set as the main contact person',
    },

    // Contact management
    contacts: {
      contact: 'Contact',
      addContact: 'Add Contact',
      removeContact: 'Remove Contact',
      primary: 'Primary',
      noContacts: 'No contacts added yet. Click "Add Contact" to add a contact person.',
    },

    // Buttons
    buttons: {
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving...',
      createCustomer: 'Create Customer',
      updateCustomer: 'Update Customer',
    },

    // Validation
    validation: {
      invalidEmail: 'Invalid email address',
      firstNameRequired: 'First name is required',
      lastNameRequired: 'Last name is required',
      fillRequired: 'Please fill in all required fields',
    },

    actions: {
      newCustomer: 'New Customer',
      editCustomer: 'Edit Customer',
      deleteCustomer: 'Delete Customer',
      mergeCustomers: 'Merge Customers',
      viewHistory: 'View History',
      sendStatement: 'Send Statement'
    },

    messages: {
      customerCreated: 'Customer created',
      customerCreatedDesc: 'The customer has been created successfully.',
      customerUpdated: 'Customer updated',
      customerUpdatedDesc: 'The customer has been updated successfully.',
      customerDeleted: 'Customer deleted successfully',
      cannotDeleteWithInvoices: 'Cannot delete customer with existing invoices',
      error: 'Error',
      failedToSave: 'Failed to save customer. Please try again.',
      validationError: 'Validation Error',
    }
  };
