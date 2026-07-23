export const accounting = {
    title: 'Accounting',
    description: 'Manage your financial records and reporting',

    // Sidebar Navigation
    sidebar: {
      groups: {
        dashboard: 'Dashboard',
        bookkeeping: 'Bookkeeping',
        sales: 'Sales',
        purchases: 'Purchases',
        banking: 'Banking',
        projects: 'Projects',
        integrations: 'Integrations',
        management: 'Management',
      },
      items: {
        overview: 'Overview',
        reports: 'Reports',
        chartOfAccounts: 'Chart of Accounts',
        journalEntries: 'Journal Entries',
        generalLedger: 'General Ledger',
        invoices: 'Invoices',
        customers: 'Customers',
        productsServices: 'Products & Services',
        bills: 'Bills',
        vendors: 'Vendors',
        expenses: 'Expenses',
        bankAccounts: 'Bank Accounts',
        transactions: 'Transactions',
        reconciliation: 'Reconciliation',
        projects: 'Projects',
        timeTracking: 'Time Tracking',
        milestones: 'Milestones',
        integrations: 'Integrations',
        budgets: 'Budgets',
        sequences: 'Sequences',
        btwAangifte: 'BTW-aangifte',
        taxSettings: 'Tax Settings',
        companySettings: 'Company Settings',
      },
    },

    dashboard: {
      title: 'Accounting Dashboard',
      bankAccounts: 'Bank Accounts',
      noBankAccounts: 'No bank accounts configured.',
      upcomingDue: 'Upcoming Due Invoices',
      noUpcomingInvoices: 'No upcoming invoices.',
      recentPayments: 'Recent Payments',
      noRecentPayments: 'No recent payments.',
      loadingMessage: 'Dashboard is loading. If this persists, try refreshing.',
      table: {
        invoice: 'Invoice',
        contact: 'Contact',
        due: 'Due',
        amount: 'Amount',
        date: 'Date',
        type: 'Type',
        method: 'Method',
        reference: 'Reference',
      },
    },
    accounts: {
      title: 'Chart of Accounts',
      pageDescription: 'Manage your general ledger accounts and account hierarchy',
      account: 'Account',
      accountCode: 'Account Code',
      accountName: 'Account Name',
      description: 'Description',
      createAccount: 'Create Account',
      editAccount: 'Edit Account',
      backToAccounts: 'Back to Accounts',

      // Form sections
      basicInformation: 'Basic Information',
      classification: 'Classification',
      openingBalance: 'Opening Balance',
      settings: 'Settings',

      // Form labels
      code: 'Account Code *',
      name: 'Account Name *',
      descriptionPlaceholder: 'Account description...',
      type: 'Account Type *',
      subtype: 'Sub Type',
      subtypePlaceholder: 'Current Assets',
      openingBalanceAmount: 'Opening Balance Amount',
      currency: 'Currency',
      isActive: 'Active',

      // Info texts
      numberingSchemeInfo: 'Use a systematic numbering scheme: 1000-1999 for Assets, 2000-2999 for Liabilities, 3000-3999 for Equity, 4000-4999 for Revenue, 5000-9999 for Expenses.',
      accountCodeTooltip: 'Enter a unique account code (e.g., 1000-9999)',

      // Account types
      types: {
        asset: 'Asset',
        assets: 'Assets',
        liability: 'Liability',
        liabilities: 'Liabilities',
        equity: 'Equity',
        revenue: 'Revenue',
        expense: 'Expense',
        expenses: 'Expenses'
      },

      // Account type descriptions
      typeDescriptions: {
        asset: 'Resources owned by the business (cash, inventory, equipment)',
        liability: "Debts owed by the business (loans, accounts payable)",
        equity: "Owner's stake in the business",
        revenue: 'Income from business operations',
        expense: 'Costs of running the business',
      },

      // Currency options
      currencies: {
        usd: 'USD - US Dollar',
        eur: 'EUR - Euro',
        gbp: 'GBP - British Pound',
      },

      // Actions
      actions: {
        addAccount: 'Add Account',
        importAccounts: 'Import Accounts',
        save: 'Save Account',
        cancel: 'Cancel',
      },

      // Messages
      messages: {
        validationError: 'Validation error',
        codeAndNameRequired: 'Account code and name are required',
        accountCreated: 'Account created successfully!',
        accountUpdated: 'Account updated successfully!',
        accountCreatedDesc: '{name} has been added to the chart of accounts.',
        accountUpdatedDesc: '{name} has been updated.',
        error: 'Error',
        failedToSave: 'Failed to save account',
        failedToCreate: 'Failed to create account',
        failedToUpdate: 'Failed to update account',
      },

      // Summary
      accountSummary: 'Account Summary',
      untitledAccount: 'Untitled Account',
      accountType: 'Account Type',
      status: 'Status',
      active: 'Active',
      inactive: 'Inactive',

      // Summary field labels
      summaryCode: 'Code',
      summaryName: 'Name',
      summaryType: 'Type',
      summarySubtype: 'Subtype',
      summaryOpeningBalance: 'Opening Balance',

      // Additional UI strings
      saveChanges: 'Save Changes',
      statusTooltip: "Inactive accounts won't appear in transaction forms",
      editing: 'Editing',

      // Page-level additions
      newAccount: 'New Account',
      accountDetails: 'Account Details',
      financial: 'Financial',
      normalSide: 'Normal Side',
      debit: 'Debit',
      credit: 'Credit',
      currentBalance: 'Current Balance',
      balances: 'Balances',
      notFound: 'Account not found.',
      creating: 'Creating...',
      saving: 'Saving...',
      cancel: 'Cancel',
      codePlaceholder: 'e.g. 1000',
      selectSubtype: 'Select subtype',
      system: 'System',

      // Subtype labels
      subtypeLabels: {
        currentAsset: 'Current Asset',
        fixedAsset: 'Fixed Asset',
        bank: 'Bank',
        cash: 'Cash',
        accountsReceivable: 'Accounts Receivable',
        inventory: 'Inventory',
        prepaidExpense: 'Prepaid Expense',
        currentLiability: 'Current Liability',
        longTermLiability: 'Long Term Liability',
        accountsPayable: 'Accounts Payable',
        taxPayable: 'Tax Payable',
        creditCard: 'Credit Card',
        ownersEquity: "Owner's Equity",
        retainedEarnings: 'Retained Earnings',
        shareCapital: 'Share Capital',
        sales: 'Sales',
        otherIncome: 'Other Income',
        interestIncome: 'Interest Income',
        serviceRevenue: 'Service Revenue',
        operatingExpense: 'Operating Expense',
        costOfGoodsSold: 'Cost of Goods Sold',
        payroll: 'Payroll',
        depreciation: 'Depreciation',
        interestExpense: 'Interest Expense',
        taxExpense: 'Tax Expense',
      },
    },

    administrations: {
      detailsDialog: {
        title: 'Administration Details',
        description: 'View configuration details for {name}',

        labels: {
          administrationName: 'Administration Name',
          country: 'Country',
          currency: 'Currency',
          language: 'Language',
          timezone: 'Timezone',
          accountingStandard: 'Accounting Standard',
          fiscalYearStart: 'Fiscal Year Start',
          taxSettings: 'Tax Settings',
          reportingRequirements: 'Reporting Requirements',
          chartOfAccountsTemplate: 'Chart of Accounts Template',
          created: 'Created',
          lastUpdated: 'Last Updated',
        },

        status: {
          active: 'Active',
          inactive: 'Inactive',
        },

        unknown: 'Unknown',
      },
    },

    generalLedger: {
      title: 'General Ledger',
      labels: {
        debits: 'Debits',
        credits: 'Credits',
        entries: 'Entries',
        accounts: 'Accounts'
      },
      actions: {
        newEntry: 'New Entry'
      }
    },
    expenses: {
      title: 'Expenses'
    },
    receivables: {
      title: 'Receivables'
    },
    payables: {
      title: 'Payables'
    },
    journal: {
      title: 'Journal Entries',
      status: {
        posted: 'Posted',
        draft: 'Draft'
      },
      actions: {
        createEntry: 'Create Entry',
        importEntries: 'Import Entries'
      },
      errors: {
        unableToLoad: 'Unable to load journal entries',
        apiConnection: 'Unable to connect to the API'
      }
    },
    recurringEntries: {
      title: 'Recurring Entries',
      status: {
        active: 'Active',
        paused: 'Paused'
      },
      frequency: {
        daily: 'Daily',
        weekly: 'Weekly',
        monthly: 'Monthly'
      },
      actions: {
        createEntry: 'Create Recurring Entry'
      },
      notFound: 'Recurring entry not found.',
      editEntry: 'Edit Recurring Entry',
      newEntry: 'New Recurring Entry',
      saving: 'Saving...',
      creating: 'Creating...',
    },

    currencyManagement: {
      title: 'Currency Management',
      subtitle: 'Manage exchange rates and currency settings',
      addCurrency: 'Add Currency',
      currency: 'Currency',
      selectCurrency: 'Select a currency...',
      selectCurrencyDescription: 'Select a currency to add to your administration',
      setAsDefault: 'Set as default currency',
      setAsDefaultDescription: 'Make this your main currency for reports',
      cancel: 'Cancel',
      adding: 'Adding...',

      // Stats
      activeCurrencies: 'Active Currencies',
      currentlyEnabled: 'Currently enabled',
      inactive: 'Inactive',
      disabledCurrencies: 'Disabled currencies',
      defaultCurrency: 'Default Currency',
      baseForReports: 'Base for reports',
      totalCurrencies: 'Total Currencies',
      inSystem: 'In system',

      // Exchange rates
      recentExchangeRateActivity: 'Recent Exchange Rate Activity',
      viewHistory: 'View History',
      euroToUsDollar: 'Euro to US Dollar',
      britishPoundToUsDollar: 'British Pound to US Dollar',
      japaneseYenToUsDollar: 'Japanese Yen to US Dollar',

      // Primary currency
      primaryCurrency: 'Primary Currency',
      allFinancialReportsCalculated: 'All financial reports and analytics are calculated in this currency',
      baseRate: 'Base Rate',
      updateRates: 'Update Rates',

      // No administration state
      noWorkspaceSelected: 'No Workspace Selected',
      selectWorkspaceMessage: 'Please select a workspace from the dropdown above to manage currencies and exchange rates',
    },

    assets: {
      title: 'Assets',
      createAsset: 'Create Asset',
      editAsset: 'Edit Asset',
      backToAssets: 'Back to Assets',

      // Sections
      assetInformation: 'Asset Information',
      physicalDetails: 'Physical Details',
      assignment: 'Assignment',
      financialDetails: 'Financial Details',
      depreciationSummary: 'Depreciation Summary',

      // Form labels
      assetNumber: 'Asset Number',
      assetName: 'Asset Name',
      status: 'Status',
      description: 'Description',
      category: 'Category',
      assetType: 'Asset Type',
      serialNumber: 'Serial Number',
      manufacturer: 'Manufacturer',
      model: 'Model',
      acquisitionDate: 'Acquisition Date',
      warrantyExpiry: 'Warranty Expiry',
      location: 'Location',
      department: 'Department',
      responsiblePerson: 'Responsible Person',
      acquisitionCost: 'Acquisition Cost',
      residualValue: 'Residual Value',
      usefulLifeYears: 'Useful Life (Years)',
      depreciationMethod: 'Depreciation Method',
      depreciationStartDate: 'Depreciation Start Date',
      notes: 'Additional Notes',

      // Placeholders
      assetNamePlaceholder: 'e.g., Dell XPS 15 Laptop',
      descriptionPlaceholder: 'Detailed description of the asset...',
      assetTypePlaceholder: 'e.g., Laptop, Forklift, etc.',
      notesPlaceholder: 'Any additional notes about this asset...',
      selectStatus: 'Select status',
      selectCategory: 'Select category',
      selectLocation: 'Select location',
      selectDepartment: 'Select department',
      selectEmployee: 'Select employee',
      searchLocation: 'Search location...',
      searchDepartment: 'Search department...',
      searchEmployee: 'Search employee...',

      // Statuses
      statuses: {
        pending: 'Pending',
        active: 'Active',
        underMaintenance: 'Under Maintenance',
        disposed: 'Disposed',
        writtenOff: 'Written Off',
      },

      // Categories
      categories: {
        buildings: 'Buildings',
        vehicles: 'Vehicles',
        equipment: 'Equipment',
        furniture: 'Furniture',
        hardware: 'Hardware',
        software: 'Software',
        land: 'Land',
        machinery: 'Machinery',
      },

      // Depreciation methods
      depreciationMethods: {
        straightLine: 'Straight Line',
        decliningBalance: 'Declining Balance',
        unitsOfProduction: 'Units of Production',
      },

      // Depreciation summary
      depreciableAmount: 'Depreciable Amount',
      depreciationRate: 'Depreciation Rate',
      monthlyDepreciation: 'Monthly Depreciation',
      annualDepreciation: 'Annual Depreciation',
      yearsLabel: 'years',
      usefulLife: 'Useful Life',
      name: 'Name',
      acquired: 'Acquired',
      assetSummary: 'Asset Summary',

      // Search/Selection
      noLocationFound: 'No location found',
      noDepartmentFound: 'No department found',
      noEmployeeFound: 'No employee found',

      // Actions
      createAssetButton: 'Create Asset',
      updateAssetButton: 'Update Asset',
      cancel: 'Cancel',
      saving: 'Saving...',

      // Messages
      validationError: 'Validation error',
      fillRequiredFields: 'Please fill in all required fields',
      enterAssetName: 'Please enter an asset name',
      enterValidAcquisitionCost: 'Please enter a valid acquisition cost',
      selectLocationRequired: 'Please select a location',
      selectDepartmentRequired: 'Please select a department',
      assetCreated: 'Asset {assetNumber} created successfully',
      assetUpdated: 'Asset updated successfully!',
      failedToCreate: 'Failed to create asset',
      failedToUpdate: 'Failed to update asset',
      unexpectedError: 'An unexpected error occurred',
    },

    bills: {
      title: 'Bills',
      createBill: 'Create Bill',
      editBill: 'Edit Bill',
      backToBills: 'Back to Bills',

      // Sections
      billInformation: 'Bill Information',
      vendorInformation: 'Vendor Information',
      lineItems: 'Line Items',
      billSummary: 'Bill Summary',

      // Form labels
      billNumber: 'Bill Number',
      status: 'Status',
      billDate: 'Bill Date',
      dueDate: 'Due Date',
      referenceNumber: 'Reference Number',
      paymentTerms: 'Payment Terms',
      vendor: 'Vendor',
      vendorName: 'Vendor Name',
      selectVendorLabel: 'Select Vendor *',
      description: 'Description',
      quantity: 'Quantity',
      unitPrice: 'Unit Price',
      taxRate: 'Tax %',
      amount: 'Amount',
      account: 'Expense Account',
      notes: 'Notes',
      additionalNotes: 'Additional Notes',

      // Placeholders
      billNumberPlaceholder: 'BILL-001',
      referenceNumberPlaceholder: 'PO-12345 or Invoice #...',
      selectStatus: 'Select status',
      selectDate: 'Select date',
      selectPaymentTerms: 'Select payment terms',
      selectVendor: 'Select a vendor...',
      selectAccount: 'Select account...',
      searchVendor: 'Search vendors...',
      searchAccount: 'Search expense accounts...',
      descriptionPlaceholder: 'Item description',
      notesPlaceholder: 'Add any notes about this bill...',
      notesPlaceholderLong: 'Enter any special instructions, payment notes, or internal comments...',
      vendorNamePlaceholder: 'ACME Corporation',
      vendorTaxIdPlaceholder: 'XX-XXXXXXX',
      vendorEmailPlaceholder: 'vendor@example.com',
      vendorPhonePlaceholder: '+1 (555) 123-4567',
      streetAddressPlaceholder: '123 Main Street',
      cityPlaceholder: 'New York',
      stateProvincePlaceholder: 'NY',
      postalCodePlaceholder: '10001',
      countryPlaceholder: 'United States',

      // Payment Terms
      paymentTermsOptions: {
        net15: 'Net 15',
        net30: 'Net 30',
        net45: 'Net 45',
        net60: 'Net 60',
        dueOnReceipt: 'Due on Receipt',
        cod: 'COD',
      },

      // Statuses
      statuses: {
        draft: 'Draft',
        pending: 'Pending',
        approved: 'Approved',
        paid: 'Paid',
        cancelled: 'Cancelled',
      },

      // Line items
      addItem: 'Add Item',
      addLineItem: 'Add Line Item',
      removeLineItem: 'Remove',
      lineItemsCount: '{count} line item',
      lineItemsCountPlural: '{count} line items',
      noItemsAdded: 'No items added',
      addItemsToStart: 'Add expense items to start building your bill',

      // Table columns
      accountColumn: 'Account',
      descriptionColumn: 'Description',
      qtyColumn: 'Qty',
      unitPriceColumn: 'Unit Price',
      taxColumn: 'Tax',
      amountColumn: 'Amount',

      // Summary labels
      subtotal: 'Subtotal',
      tax: 'Tax',
      total: 'Total',
      totalItems: 'Total Items',
      totalItemsCount: '{count} total items',
      billDateLabel: 'Bill Date:',
      dueLabel: 'Due:',

      // Vendor info
      noVendorFound: 'No vendor found',
      noVendorSelected: 'No vendor selected',
      selectVendorFirst: 'Please select a vendor first',
      noVendorsAvailable: 'No vendors available',
      addVendorsFirst: 'Please add vendors to your account first',
      vendorContact: 'Contact',
      vendorContactName: 'Contact Name',
      vendorEmail: 'Email',
      vendorPhone: 'Phone',
      vendorTaxId: 'Tax ID',
      vendorAddress: 'Vendor Address',
      streetAddress: 'Street Address',
      city: 'City',
      stateProvince: 'State/Province',
      postalCode: 'Postal Code',
      country: 'Country',

      // Account info
      noAccountFound: 'No accounts found.',
      accountBalance: 'Balance',

      // Actions
      createBillButton: 'Create Bill',
      updateBillButton: 'Update Bill',
      cancel: 'Cancel',
      saving: 'Saving...',
      creatingBill: 'Creating Bill...',

      // Messages
      validationError: 'Validation error',
      selectVendorRequired: 'Please select a vendor',
      addAtLeastOneItem: 'Please add at least one line item',
      billCreated: 'Bill {billNumber} created successfully',
      billUpdated: 'Bill updated successfully!',
      failedToCreate: 'Failed to create bill',
      failedToUpdate: 'Failed to update bill',
      unexpectedError: 'An unexpected error occurred',

      // Stats
      stats: {
        totalBills: 'Total Bills',
        totalBillsDesc: 'All bills',
        overdue: 'Overdue',
        overdueDesc: 'Past due date',
        paidLabel: 'Paid',
        paidDesc: 'Total paid',
        pending: 'Pending',
        pendingDesc: 'Awaiting payment',
      },

      // Filters
      filters: {
        all: 'All',
        draft: 'Draft',
        pending: 'Pending Approval',
        approved: 'Approved',
        unpaid: 'Unpaid',
        paid: 'Paid',
        overdue: 'Overdue',
      },

      // Table headers
      table: {
        billNumber: 'Bill #',
        vendor: 'Vendor',
        billDate: 'Bill Date',
        dueDate: 'Due Date',
        status: 'Status',
        total: 'Total',
        balanceDue: 'Balance Due',
        unknownVendor: 'Unknown Vendor',
      },

      // Actions menu
      actionsMenu: {
        openMenu: 'Open menu',
        actions: 'Actions',
        viewBill: 'View Bill',
        submitForApproval: 'Submit for Approval',
        approveBill: 'Approve Bill',
        recordPayment: 'Record Payment',
        duplicate: 'Duplicate',
        downloadPdf: 'Download PDF',
        deleteBill: 'Delete',
        confirmDelete: 'Are you sure you want to delete this bill? This action cannot be undone.',
        duplicateFeature: 'Duplicate feature coming soon',
        pdfDownloadFeature: 'PDF download feature coming soon',
        paymentRecordingFeature: 'Payment recording feature coming soon',
      },

      // Loading and empty states
      loadingBills: 'Loading bills...',
      selectAdministration: 'Please select an administration to view bills.',
      noBillsFound: 'No bills found.',

      // Additional status labels for bills (beyond the statuses object)
      statusLabels: {
        pendingApproval: 'Pending Approval',
        partiallyPaid: 'Partially Paid',
        disputed: 'Disputed',
      },

      // Messages for list
      messages: {
        billStatusUpdated: 'Bill {status} successfully',
        updateFailed: 'Failed to update bill',
        billDeleted: 'Bill deleted successfully',
        deleteFailed: 'Failed to delete bill',
      },
    },

    budgets: {
      title: 'Budgets',
      createBudget: 'Create Budget',
      editBudget: 'Edit Budget',
      backToBudgets: 'Back to Budgets',

      // Sections
      basicInformation: 'Basic Information',
      budgetOwner: 'Budget Owner',
      budgetAmountAndPeriod: 'Budget Amount & Period',
      additionalInformation: 'Additional Information',
      budgetSummary: 'Budget Summary',

      // Form labels
      budgetName: 'Budget Name',
      period: 'Period',
      budgetType: 'Budget Type',
      department: 'Department',
      description: 'Description',
      owner: 'Owner *',
      approvalThreshold: 'Approval Threshold',
      totalBudget: 'Total Budget',
      startDate: 'Start Date',
      endDate: 'End Date',
      notes: 'Notes',

      // Placeholders
      budgetNamePlaceholder: 'Q1 2024 Operating Budget',
      periodPlaceholder: 'Q1 2024',
      selectDepartment: 'Select department',
      selectOwner: 'Select owner',
      descriptionPlaceholder: 'Describe the purpose and scope of this budget...',
      approvalThresholdPlaceholder: '5000.00',
      totalBudgetPlaceholder: '500000.00',
      notesPlaceholder: 'Add any additional notes or special instructions...',

      // Budget Types
      budgetTypes: {
        operational: 'Operational',
        project: 'Project',
        capital: 'Capital',
        strategic: 'Strategic',
      },

      // Departments
      departments: {
        companyWide: 'Company Wide',
        sales: 'Sales',
        marketing: 'Marketing',
        operations: 'Operations',
        it: 'IT',
        hr: 'Human Resources',
        finance: 'Finance',
        rd: 'Research & Development',
      },

      // Settings
      requireApproval: 'Require Approval',
      requireApprovalDesc: 'All expenses must be approved before processing',
      allowOverspend: 'Allow Overspend',
      allowOverspendDesc: 'Permit expenses that exceed the allocated budget',
      activateImmediately: 'Activate Immediately',
      activateImmediatelyDesc: 'Set this budget as active immediately upon creation',
      approvalThresholdHelp: 'Expenses above this amount require approval',

      // Summary labels
      type: 'Type',
      approval: 'Approval:',
      notSet: 'Not set',

      // Actions
      createBudgetButton: 'Create Budget',
      updateBudgetButton: 'Update Budget',
      cancel: 'Cancel',
      creatingBudget: 'Creating Budget...',
      saving: 'Saving...',

      // Messages
      fillRequired: 'Please fill in all required fields',
      selectDates: 'Please select start and end dates',
      budgetCreated: 'Budget created successfully',
      budgetUpdated: 'Budget updated successfully',
      failedToCreate: 'Failed to create budget',
      failedToUpdate: 'Failed to update budget',
    },

    cashEntries: {
      title: 'Cash Entries',
      newCashEntry: 'New Cash Entry',
      editCashEntry: 'Edit Cash Entry',
      backToCashEntries: 'Back to cash entries',

      // Sections
      entryInformation: 'Entry Information',
      entryInformationDesc: 'Basic details about the cash transaction',
      transactionDetails: 'Transaction Details',
      transactionDetailsDesc: 'Additional information about the transaction',
      additionalNotes: 'Additional Notes',
      additionalNotesDesc: 'Optional notes about this cash entry',
      entrySummary: 'Entry Summary',

      // Form labels
      date: 'Date',
      referenceNumber: 'Reference Number',
      type: 'Type',
      amount: 'Amount',
      payeePayer: 'Payee/Payer',
      category: 'Category',
      description: 'Description',
      notes: 'Notes',

      // Placeholders
      referencePlaceholder: 'e.g., CASH-001',
      amountPlaceholder: '0.00',
      payeePlaceholder: 'Name of person or company',
      selectCategory: 'Select category',
      descriptionPlaceholder: 'Brief description of the transaction',
      notesPlaceholder: 'Enter any additional notes or details...',

      // Types
      cashReceipt: 'Cash Receipt',
      cashPayment: 'Cash Payment',
      receipt: 'Receipt',
      payment: 'Payment',

      // Categories
      categories: {
        salesRevenue: 'Sales Revenue',
        serviceIncome: 'Service Income',
        customerRefunds: 'Customer Refunds',
        officeSupplies: 'Office Supplies',
        utilities: 'Utilities',
        rent: 'Rent',
        salariesWages: 'Salaries & Wages',
        equipmentPurchase: 'Equipment Purchase',
        other: 'Other',
      },

      // Actions
      createCashEntry: 'Create Cash Entry',
      updateCashEntry: 'Update Cash Entry',
      recordCashEntry: 'Record a cash receipt or payment',

      // Messages
      enterValidAmount: 'Please enter a valid amount',
      enterDescription: 'Please enter a description',
      cashEntryCreated: 'Cash entry created successfully',
      cashEntryUpdated: 'Cash entry updated successfully',
      failedToCreate: 'Failed to create cash entry',
      failedToUpdate: 'Failed to update cash entry',
    },

    vendors: {
      title: 'Vendors',
      createNewVendor: 'Create New Vendor',
      editVendor: 'Edit Vendor',
      backToVendors: 'Back to vendors',
      vendorSummary: 'Vendor Summary',

      // Sections
      basicInformation: 'Basic Information',
      basicInformationDesc: 'Company details and identification',
      contactInformation: 'Contact Information',
      contactInformationDesc: 'Primary contact details',
      addressInformation: 'Address Information',
      addressInformationDesc: 'Business address',
      paymentDetails: 'Payment Details',
      paymentDetailsDesc: 'Payment terms and banking information',
      accountConfiguration: 'Account Configuration',
      accountConfigurationDesc: 'Accounting settings and categorization',
      additionalInformation: 'Additional Information',
      additionalInformationDesc: 'Notes and tags',
      bankAccountInformation: 'Bank Account Information (Optional)',

      // Form labels
      vendorCode: 'Vendor Code',
      taxId: 'Tax ID / VAT Number',
      companyName: 'Company Name',
      website: 'Website',
      primaryContact: 'Primary Contact',
      emailAddress: 'Email Address',
      phoneNumber: 'Phone Number',
      streetAddress: 'Street Address',
      addressLine2: 'Address Line 2',
      city: 'City',
      stateProvince: 'State/Province',
      postalCode: 'Postal Code',
      country: 'Country',
      paymentTerms: 'Payment Terms',
      currency: 'Currency',
      creditLimit: 'Credit Limit',
      bankName: 'Bank Name',
      routingNumber: 'Routing Number',
      bankAccountNumber: 'Bank Account Number',
      defaultExpenseAccount: 'Default Expense Account',
      vendorCategory: 'Vendor Category',
      tags: 'Tags',
      notes: 'Notes',

      // Placeholders
      taxIdPlaceholder: 'XX-XXXXXXX',
      companyPlaceholder: 'ACME Corporation',
      websitePlaceholder: 'https://example.com',
      contactPlaceholder: 'John Doe',
      emailPlaceholder: 'vendor@example.com',
      phonePlaceholder: '+1 (555) 123-4567',
      streetAddressPlaceholder: '123 Main Street',
      addressLine2Placeholder: 'Suite 100',
      cityPlaceholder: 'New York',
      postalCodePlaceholder: '10001',
      selectState: 'Select state',
      selectCountry: 'Select country',
      selectPaymentTerms: 'Select payment terms',
      selectCurrency: 'Select currency',
      creditLimitPlaceholder: '10000.00',
      bankNamePlaceholder: 'Chase Bank',
      routingPlaceholder: '021000021',
      bankAccountPlaceholder: 'XXXX-XXXX-XXXX',
      expenseAccountPlaceholder: 'Expenses:Operating',
      selectCategory: 'Select category',
      tagsPlaceholder: 'Comma-separated tags (e.g., office-supplies, preferred)',
      notesPlaceholder: 'Enter any additional notes about this vendor...',

      // Payment Terms
      paymentTermsOptions: {
        net15: 'Net 15',
        net30: 'Net 30',
        net45: 'Net 45',
        net60: 'Net 60',
        dueOnReceipt: 'Due on Receipt',
        cod: 'COD',
        prepaid: 'Prepaid',
      },

      // Currencies
      currencies: {
        usd: 'USD - US Dollar',
        eur: 'EUR - Euro',
        gbp: 'GBP - British Pound',
        cad: 'CAD - Canadian Dollar',
        mxn: 'MXN - Mexican Peso',
        cny: 'CNY - Chinese Yuan',
        jpy: 'JPY - Japanese Yen',
        inr: 'INR - Indian Rupee',
      },

      // Vendor Categories
      categories: {
        supplier: 'Supplier',
        contractor: 'Contractor',
        serviceProvider: 'Service Provider',
        consultant: 'Consultant',
        utility: 'Utility',
      },

      // Settings
      active: 'Active',
      preferred: 'Preferred',
      sendRemittance: 'Send Remittance',
      is1099Vendor: '1099 Vendor (for US tax reporting)',
      status: 'Status',
      preferredVendor: 'Preferred Vendor',
      email: 'Email',
      phone: 'Phone',
      company: 'Company',

      // States
      noStatesAvailable: 'No states available',
      inactive: 'Inactive',

      // Actions
      createVendor: 'Create Vendor',
      updateVendor: 'Update Vendor',

      // Messages
      companyNameRequired: 'Company name is required',
      provideEmailOrPhone: 'Please provide either an email or phone number',
      vendorCreated: 'Vendor {vendorCode} created successfully',
      vendorUpdated: 'Vendor updated successfully',
      failedToCreate: 'Failed to create vendor',
      failedToUpdate: 'Failed to update vendor',
      unexpectedError: 'An unexpected error occurred',

      // List component
      loadingVendors: 'Loading vendors...',
      searchVendors: 'Search vendors...',
      vendorsCount: '{count} vendors',
      noVendorsFound: 'No vendors found.',
      noVendorsSearch: 'No vendors found matching your search.',

      // Filters
      filters: {
        all: 'All',
        preferred: 'Preferred',
      },

      // Table headers
      table: {
        vendor: 'Vendor',
        contact: 'Contact',
        details: 'Details',
        activity: 'Activity',
        bills: 'Bills',
        totalSpent: 'Total Spent',
        outstanding: 'Outstanding',
        contactLabel: 'Contact:',
        termsLabel: 'Terms:',
        leadTime: 'Lead time:',
        days: 'days',
        pos: 'POs',
        lastActivity: 'Last:',
      },

      // Activity Status (reusing from customers)
      activityStatus: {
        active: 'Active',
        inactive: 'Inactive',
        dormant: 'Dormant',
      },

      // Actions Menu
      actionsMenu: {
        openMenu: 'Open menu',
        actions: 'Actions',
        viewDetails: 'View Details',
        editVendor: 'Edit Vendor',
        visitWebsite: 'Visit Website',
        deactivate: 'Deactivate',
        confirmDeactivate: 'Are you sure you want to deactivate {name}? They will be hidden from the vendor list but their data will be preserved.',
      },

      // Messages for list
      messages: {
        vendorDeactivated: 'Vendor deactivated successfully',
        deactivateFailed: 'Failed to deactivate vendor',
      },

      // Stats component
      stats: {
        totalVendors: 'Total Vendors',
        totalVendorsDesc: 'Active vendors',
        preferred: 'Preferred',
        preferredDesc: 'Preferred vendors',
        totalSpent: 'Total Spent',
        totalSpentDesc: 'All time spending',
        outstanding: 'Outstanding',
        outstandingDesc: 'Unpaid bills',
      },
    },

    currency: {
      title: 'Currency',
      newCurrency: 'New Currency',
      currencySummary: 'Currency Summary',

      // Sections
      currencyInformation: 'Currency Information',
      exchangeRate: 'Exchange Rate',
      additionalSettings: 'Additional Settings',

      // Form labels
      currencyCode: 'Currency Code',
      codeHelpText: 'ISO 4217 three-letter code',
      currencyName: 'Currency Name',
      symbol: 'Symbol',
      decimalPlaces: 'Decimal Places',
      exchangeRateToBase: 'Exchange Rate to Base Currency',
      exchangeRateHelpText: 'Rate at which this currency converts to your base currency',
      setAsBaseCurrency: 'Set as Base Currency',
      setAsBaseCurrencyDesc: 'Use this currency as your company\'s base currency',
      activeCurrency: 'Active Currency',
      activeCurrencyDesc: 'Enable this currency for use in transactions',

      // Decimal places options
      decimalOptions: {
        zero: '0 (no decimals)',
        two: '2 (default)',
        three: '3',
        four: '4',
      },

      // Placeholders
      codePlaceholder: 'USD',
      namePlaceholder: 'US Dollar',
      symbolPlaceholder: '$',
      exchangeRatePlaceholder: '1.0000',
      notesPlaceholder: 'Add any additional notes about this currency...',

      // Summary labels
      code: 'Code',
      name: 'Name',
      symbolLabel: 'Symbol',
      symbolDisplay: 'Symbol: {symbol}',
      active: 'Active',
      inactive: 'Inactive',
      baseCurrency: 'Base Currency',

      // Actions and messages
      addCurrency: 'Add Currency',
      addingCurrency: 'Adding Currency...',
      cancel: 'Cancel',
      fillRequired: 'Please fill in all required fields',
      enterValidRate: 'Please enter a valid exchange rate',
      currencyAdded: 'Currency added successfully',
      failedToAdd: 'Failed to add currency',
    },

    directDebits: {
      title: 'Direct Debits',
      newDirectDebit: 'New Direct Debit',
      debitSummary: 'Direct Debit Summary',

      // Sections
      basicInformation: 'Basic Information',
      vendorSelection: 'Vendor Selection',
      bankAccountAndMandate: 'Bank Account & Mandate',
      paymentSchedule: 'Payment Schedule',
      additionalSettings: 'Additional Settings',

      // Form labels
      reference: 'Reference',
      amount: 'Amount *',
      description: 'Description',
      descriptionPlaceholder: 'e.g., Monthly subscription payment',
      selectVendor: 'Select a vendor...',
      searchVendors: 'Search vendors...',
      noVendorsFound: 'No vendors found.',
      addVendorFirst: 'Please add a vendor first',
      selectedVendor: 'Selected Vendor',
      accountNumber: 'Account',
      sortCode: 'Sort Code',

      selectBankAccount: 'Select bank account...',
      searchBankAccounts: 'Search bank accounts...',
      noBankAccountsFound: 'No bank accounts found.',
      accountType: 'Type',
      balance: 'Balance',

      mandate: 'Mandate *',
      selectMandate: 'Select mandate...',
      searchMandates: 'Search mandates...',
      noMandatesFound: 'No mandates found.',
      mandateReference: 'Ref',
      mandateStatus: 'Status',
      mandateSignedDate: 'Signed',
      mandateExpiry: 'Expiry',

      frequency: 'Frequency *',
      firstPaymentDate: 'First Payment Date *',
      pickDate: 'Pick a date',
      dayOfMonth: 'Day of Month',
      dayOfWeek: 'Day of Week',

      // Frequency options
      frequencies: {
        weekly: 'Weekly',
        biweekly: 'Bi-weekly',
        monthly: 'Monthly',
        quarterly: 'Quarterly',
        annually: 'Annually',
      },

      // Days of week
      daysOfWeek: {
        monday: 'Monday',
        tuesday: 'Tuesday',
        wednesday: 'Wednesday',
        thursday: 'Thursday',
        friday: 'Friday',
        saturday: 'Saturday',
        sunday: 'Sunday',
      },

      notes: 'Notes',
      notesPlaceholder: 'Add any additional notes about this direct debit...',
      notifyVendor: 'Notify Vendor',
      notifyVendorDesc: 'Send an email notification to the vendor when payment is processed',

      // Preview
      nextPaymentDates: 'Next Payment Dates',
      previewDescription: 'Based on your selected frequency, here are the next {count} payment dates:',
      totalPerPayment: 'per payment',

      // Vendor info alert
      vendorInfoTitle: 'Vendor Bank Details',
      vendorInfoAccount: 'Account: {accountNumber}',
      vendorInfoSort: 'Sort Code: {sortCode}',

      // Summary labels
      referenceNumber: 'Reference',
      totalAmount: 'Amount',
      frequencyLabel: 'Frequency',
      vendor: 'Vendor',
      bankAccount: 'Bank Account',
      mandateRef: 'Mandate',
      firstPayment: 'First Payment',
      notifying: 'Notifying Vendor',
      yes: 'Yes',
      no: 'No',

      // Status badges
      statusActive: 'Active',
      statusPending: 'Pending',
      statusExpired: 'Expired',
      statusCancelled: 'Cancelled',

      // Actions and messages
      createDirectDebit: 'Create Direct Debit',
      creatingDirectDebit: 'Creating Direct Debit...',
      cancel: 'Cancel',

      // Validation messages
      selectVendorRequired: 'Please select a vendor',
      selectBankAccountRequired: 'Please select a bank account',
      selectMandateRequired: 'Please select a mandate',
      enterValidAmount: 'Please enter a valid amount',
      selectFirstPaymentDate: 'Please select the first payment date',
      directDebitCreated: 'Direct debit {reference} created successfully',
      failedToCreate: 'Failed to create direct debit',
      unexpectedError: 'An unexpected error occurred',
    },

    paymentBatches: {
      title: 'Payment Batches',
      newPaymentBatch: 'New Payment Batch',
      batchSummary: 'Batch Summary',

      // Sections
      batchInformation: 'Batch Information',
      bankAccountSelection: 'Bank Account Selection',
      addPayments: 'Add Payments to Batch',
      batchPayments: 'Batch Payments',
      processingSchedule: 'Processing & Schedule',

      // Form labels
      batchNumber: 'Batch Number',
      batchType: 'Batch Type',
      paymentDate: 'Payment Date *',
      selectDate: 'Select date',
      description: 'Description',
      descriptionPlaceholder: 'e.g., Monthly vendor payments - January 2024',

      // Batch types
      batchTypes: {
        vendorPayments: 'Vendor Payments',
        employeePayroll: 'Employee Payroll',
        taxPayments: 'Tax Payments',
        other: 'Other',
      },

      // Bank account
      selectBankAccount: 'Select Bank Account *',
      searchBankAccounts: 'Search bank accounts...',
      noBankAccountsFound: 'No bank accounts found.',
      availableBalance: 'Available Balance',

      // Vendor & payment selection
      selectVendor: 'Select Vendor',
      searchVendors: 'Search vendors...',
      noVendorsFound: 'No vendors found.',
      outstandingBalance: 'Outstanding',
      paymentTerms: 'Terms',

      paymentAmount: 'Payment Amount',
      amountPlaceholder: '0.00',
      paymentMethod: 'Payment Method',
      selectPaymentMethod: 'Select payment method',
      memo: 'Memo (Optional)',
      memoPlaceholder: 'Payment reference or notes...',

      selectBills: 'Select Bills to Pay',
      noBillsAvailable: 'No outstanding bills for this vendor',
      billNumber: 'Bill #',
      billDate: 'Date',
      dueDate: 'Due',
      billAmount: 'Amount',

      addToQueue: 'Add to Queue',
      addPayment: 'Add Payment',

      // Payment methods
      paymentMethods: {
        ach: 'ACH Transfer',
        wire: 'Wire Transfer',
        check: 'Check',
        card: 'Card',
      },

      // Batch payments table
      paymentsInBatch: 'Payments in Batch ({count})',
      noPaymentsAdded: 'No payments added yet',
      addPaymentsToStart: 'Add vendor payments to start building your batch',
      selectAll: 'Select All',
      deselectAll: 'Deselect All',

      vendorColumn: 'Vendor',
      amountColumn: 'Amount',
      methodColumn: 'Method',
      billsColumn: 'Bills',
      memoColumn: 'Memo',
      actionsColumn: 'Actions',

      billsCount: '{count} bill(s)',
      remove: 'Remove',
      edit: 'Edit',

      // Processing
      processBatch: 'Process Batch',
      processingDate: 'Processing Date',
      scheduleForLater: 'Schedule for Later',
      processImmediately: 'Process Immediately',
      processImmediatelyDesc: 'Process all payments in this batch right now',
      scheduleProcessing: 'Schedule Processing',
      scheduleProcessingDesc: 'Schedule batch processing for a specific date and time',

      // Summary
      totalPayments: 'Total Payments',
      totalAmount: 'Total Amount',
      selectedPayments: 'Selected Payments',
      batchDate: 'Batch Date',
      bankAccount: 'Bank Account',
      batchStatus: 'Status',
      processingFees: 'Processing Fees',
      netAmount: 'Net Amount',
      afterPayment: 'After Payment',

      // Status
      statusDraft: 'Draft',
      statusScheduled: 'Scheduled',
      statusProcessing: 'Processing',
      statusCompleted: 'Completed',

      // Actions
      createBatch: 'Create Batch',
      creatingBatch: 'Creating Batch...',
      saveDraft: 'Save Draft',
      cancel: 'Cancel',

      // Validation messages
      selectVendorRequired: 'Please select a vendor',
      enterValidAmount: 'Please enter a valid payment amount',
      paymentUpdated: 'Payment updated',
      paymentAdded: 'Payment added to batch',
      addAtLeastOnePayment: 'Please add at least one payment to the batch',
      selectBankAccountRequired: 'Please select a bank account',
      insufficientFunds: 'Insufficient funds in selected bank account',
      batchCreated: 'Payment batch {batchNumber} created successfully',
      failedToCreate: 'Failed to create payment batch',
      unexpectedError: 'An unexpected error occurred',

      // Warnings
      insufficientFundsWarning: 'Insufficient Funds',
      insufficientFundsDesc: 'The selected bank account does not have sufficient funds to process all payments in this batch.',
      currentBalance: 'Current balance: {balance}',
      requiredAmount: 'Required amount: {amount}',
    },

    customers: {
      title: 'Customers',
      newCustomer: 'New Customer',
      createCustomer: 'Create Customer',
      creatingCustomer: 'Creating Customer...',

      // Form sections
      basicInformation: 'Basic Information',
      contactInformation: 'Contact Information',
      billingAddress: 'Billing Address',
      shippingAddress: 'Shipping Address',
      accountDetails: 'Account Details',
      additionalInformation: 'Additional Information',
      customerSummary: 'Customer Summary',

      // Basic Information
      customerCode: 'Customer Code',
      customerType: 'Customer Type',
      selectType: 'Select type',
      companyName: 'Company Name',
      companyPlaceholder: 'ACME Corporation',
      firstName: 'First Name',
      firstNamePlaceholder: 'John',
      lastName: 'Last Name',
      lastNamePlaceholder: 'Doe',
      taxId: 'Tax ID',
      taxIdPlaceholder: 'XX-XXXXXXX',
      industry: 'Industry',
      selectIndustry: 'Select industry',

      // Contact Information
      email: 'Email',
      emailPlaceholder: 'john@example.com',
      phone: 'Phone',
      phonePlaceholder: '+1 (555) 123-4567',
      mobile: 'Mobile',
      mobilePlaceholder: '+1 (555) 987-6543',
      website: 'Website',
      websitePlaceholder: 'https://example.com',

      // Address fields
      streetAddress: 'Street Address',
      streetAddressPlaceholder: '123 Main Street',
      addressLine2: 'Address Line 2 (Optional)',
      addressLine2Placeholder: 'Suite, Apt, Floor',
      city: 'City',
      cityPlaceholder: 'New York',
      stateProvince: 'State / Province',
      selectState: 'Select state',
      postalCode: 'Postal Code',
      postalCodePlaceholder: '10001',
      country: 'Country',
      selectCountry: 'Select country',

      // Shipping Address
      sameAsBilling: 'Same as Billing Address',
      sameAsBillingDesc: 'Use billing address for shipping',

      // Account Details
      paymentTerms: 'Payment Terms',
      selectPaymentTerms: 'Select payment terms',
      creditLimit: 'Credit Limit',
      creditLimitPlaceholder: '10000.00',
      discountRate: 'Discount Rate (%)',
      discountPlaceholder: '5',
      currency: 'Currency',
      selectCurrency: 'Select currency',
      preferredPaymentMethod: 'Preferred Payment Method',
      selectPaymentMethod: 'Select payment method',

      // Payment Terms Options
      paymentTermsOptions: {
        net15: 'Net 15',
        net30: 'Net 30',
        net45: 'Net 45',
        net60: 'Net 60',
        dueOnReceipt: 'Due on Receipt',
        cod: 'COD',
        prepaid: 'Prepaid',
      },

      // Customer Types
      customerTypes: {
        individual: 'Individual',
        business: 'Business',
        corporate: 'Corporate',
        government: 'Government',
        nonprofit: 'Non-Profit',
      },

      // Payment Method Options
      paymentMethodOptions: {
        cash: 'Cash',
        check: 'Check',
        creditCard: 'Credit Card',
        debitCard: 'Debit Card',
        ach: 'ACH Transfer',
        wire: 'Wire Transfer',
        paypal: 'PayPal',
      },

      // Currency Options
      currencyOptions: {
        usd: 'USD - US Dollar',
        eur: 'EUR - Euro',
        gbp: 'GBP - British Pound',
        cad: 'CAD - Canadian Dollar',
        mxn: 'MXN - Mexican Peso',
        cny: 'CNY - Chinese Yuan',
        jpy: 'JPY - Japanese Yen',
        inr: 'INR - Indian Rupee',
      },

      // Additional Settings
      notes: 'Notes',
      notesPlaceholder: 'Enter any additional notes about this customer...',
      isActive: 'Active Customer',
      isActiveDesc: 'Customer can place orders and make purchases',
      isVip: 'VIP Customer',
      isVipDesc: 'Mark as VIP for special treatment',
      allowCredit: 'Allow Credit Purchases',
      allowCreditDesc: 'Allow this customer to make credit purchases',

      // Summary
      customerInfo: 'Customer Information',
      customerName: 'Name',
      customerEmail: 'Email',
      customerPhone: 'Phone',
      customerWebsite: 'Website',
      billingLocation: 'Billing Location',
      shippingLocation: 'Shipping Location',
      creditLimitLabel: 'Credit Limit',
      discountRateLabel: 'Discount Rate',
      status: 'Status',
      vipStatus: 'VIP Status',
      active: 'Active',
      inactive: 'Inactive',
      vip: 'VIP Customer',
      standard: 'Standard',

      // Validation messages
      provideNameOrCompany: 'Please provide either a company name or first and last name',
      provideEmailOrPhone: 'Please provide either an email or phone number',
      customerCreated: 'Customer {code} created successfully',
      failedToCreate: 'Failed to create customer',
      unexpectedError: 'An unexpected error occurred',

      // Actions
      cancel: 'Cancel',

      // List component
      loadingCustomers: 'Loading customers...',
      searchCustomers: 'Search customers...',
      customersCount: '{filtered} of {total} customers',
      noCustomersFound: 'No customers found.',
      noCustomersSearch: 'No customers found matching your search.',

      // Table headers
      table: {
        customer: 'Customer',
        contact: 'Contact',
        location: 'Location',
        activity: 'Activity',
        invoices: 'Invoices',
        revenue: 'Revenue',
        outstanding: 'Outstanding',
        noLocation: 'No location',
        lastActivity: 'Last:',
        orders: 'orders',
      },

      // Activity Status
      activityStatus: {
        active: 'Active',
        inactive: 'Inactive',
        dormant: 'Dormant',
      },

      // Actions Menu
      actionsMenu: {
        openMenu: 'Open menu',
        actions: 'Actions',
        viewDetails: 'View Details',
        editCustomer: 'Edit Customer',
        deleteCustomer: 'Delete',
        confirmDelete: 'Are you sure you want to delete {name}? This action cannot be undone.',
      },

      // Messages
      messages: {
        customerDeleted: 'Customer deleted successfully',
        deleteFailed: 'Failed to delete customer',
      },

      // Stats component
      stats: {
        totalCustomers: 'Total Customers',
        totalCustomersDesc: 'All customers',
        newThisMonth: 'New This Month',
        newThisMonthDesc: 'Added this month',
        totalRevenue: 'Total Revenue',
        totalRevenueDesc: 'Lifetime value',
        outstanding: 'Outstanding',
        outstandingDesc: 'Unpaid invoices',
      },
    },

    products: {
      title: 'Products',
      newProduct: 'New Product',
      createProduct: 'Create Product',
      creatingProduct: 'Creating Product...',
      productSummary: 'Product Summary',

      // Sections
      productInformation: 'Product Information',
      categoryOrganization: 'Category & Organization',
      pricingInformation: 'Pricing Information',
      inventoryManagement: 'Inventory Management',
      physicalAttributes: 'Physical Attributes',
      additionalNotes: 'Additional Notes',

      // Product Information
      skuCode: 'SKU Code',
      barcode: 'Barcode',
      enterBarcode: 'Enter barcode',
      productName: 'Product Name',
      enterProductName: 'Enter product name',
      description: 'Description',
      productDescription: 'Product description',

      // Category & Organization
      productCategory: 'Product Category',
      searchCategories: 'Search categories...',
      noCategoriesFound: 'No categories found.',
      selectCategory: 'Select a category',
      vendor: 'Vendor',
      searchVendors: 'Search vendors...',
      noVendorsFound: 'No vendors found.',
      selectVendor: 'Select a vendor',
      warehouse: 'Warehouse',
      searchWarehouses: 'Search warehouses...',
      noWarehousesFound: 'No warehouses found.',
      selectWarehouse: 'Select a warehouse',

      // Pricing
      unitPrice: 'Unit Price',
      unitPricePlaceholder: '0.00',
      costPrice: 'Cost Price',
      costPricePlaceholder: '0.00',
      taxRate: 'Tax Rate (%)',
      taxRatePlaceholder: '0',
      markup: 'Markup',
      markupPercentage: 'Markup %',
      profitMargin: 'Profit Margin',
      profitMarginPercentage: 'Margin %',

      // Inventory
      trackInventory: 'Track Inventory',
      trackInventoryDesc: 'Enable inventory tracking for this product',
      currentStock: 'Current Stock',
      currentStockPlaceholder: '0',
      minStock: 'Minimum Stock Level',
      minStockPlaceholder: '0',
      maxStock: 'Maximum Stock Level',
      maxStockPlaceholder: '0',
      reorderPoint: 'Reorder Point',
      reorderPointPlaceholder: '0',
      reorderQuantity: 'Reorder Quantity',
      reorderQuantityPlaceholder: '0',

      // Physical Attributes
      weight: 'Weight',
      weightPlaceholder: '0.00',
      weightUnit: 'Unit',
      length: 'Length',
      lengthPlaceholder: '0.00',
      width: 'Width',
      widthPlaceholder: '0.00',
      height: 'Height',
      heightPlaceholder: '0.00',
      dimensionsUnit: 'Unit',

      // Units
      kg: 'kg',
      lbs: 'lbs',
      cm: 'cm',
      inches: 'in',

      // Notes
      notes: 'Notes',
      notesPlaceholder: 'Enter any additional notes about this product...',

      // Settings
      isActive: 'Active Product',
      isActiveDesc: 'Product is available for sale',
      isFeatured: 'Featured Product',
      isFeaturedDesc: 'Show product as featured',
      allowBackorder: 'Allow Backorder',
      allowBackorderDesc: 'Allow orders when out of stock',

      // Summary
      sku: 'SKU',
      category: 'Category',
      price: 'Price',
      cost: 'Cost',
      stock: 'Stock',
      status: 'Status',
      active: 'Active',
      inactive: 'Inactive',
      featured: 'Featured',
      inStock: 'In Stock',
      lowStock: 'Low Stock',
      outOfStock: 'Out of Stock',

      // Validation
      productNameRequired: 'Please enter a product name',
      enterValidPrice: 'Please enter a valid unit price',
      enterValidCost: 'Please enter a valid cost price',
      productCreated: 'Product {sku} created successfully',
      failedToCreate: 'Failed to create product',
      unexpectedError: 'An unexpected error occurred',

      // Actions
      cancel: 'Cancel',

      // List component
      loadingProducts: 'Loading products...',
      searchProducts: 'Search products...',
      productsCount: '{count} products',
      noProductsFound: 'No products found.',
      noProductsFilters: 'No products found matching your filters.',

      // Filters
      filters: {
        category: 'Category',
        allCategories: 'All Categories',
        uncategorized: 'Uncategorized',
        stock: 'Stock',
        allStock: 'All Stock',
      },

      // Table headers
      table: {
        product: 'Product',
        category: 'Category',
        stock: 'Stock',
        price: 'Price',
        sales: 'Sales',
        created: 'Created',
        skuLabel: 'SKU:',
        sold: 'sold',
        invoiced: 'invoiced',
      },

      // Actions Menu
      actionsMenu: {
        openMenu: 'Open menu',
        actions: 'Actions',
        viewDetails: 'View Details',
        editProduct: 'Edit Product',
        deactivate: 'Deactivate',
        confirmDeactivate: 'Are you sure you want to deactivate {name}? It will be hidden from the product list but its data will be preserved.',
      },

      // Messages
      messages: {
        productDeactivated: 'Product deactivated successfully',
        deactivateFailed: 'Failed to deactivate product',
      },

      // Stats component
      stats: {
        totalProducts: 'Total Products',
        totalProductsDesc: 'All products',
        active: 'Active',
        activeDesc: 'Available products',
        lowStock: 'Low Stock',
        lowStockDesc: 'Stock below 10',
        inventoryValue: 'Inventory Value',
        inventoryValueDesc: 'Total product value',
      },
    },

    // Integrations
    integrations: {
      title: 'Integrations',
      dashboard: 'Integration Dashboard',
      quickBooksIntegration: 'QuickBooks Integration Dashboard',
      exactOnlineIntegration: 'Exact Online Integration Dashboard',

      status: {
        connected: 'Connected',
        disconnected: 'Disconnected',
        completed: 'Completed',
        failed: 'Failed',
        inProgress: 'In Progress',
        unknown: 'Unknown',
      },

      buttons: {
        settings: 'Settings',
        fullSync: 'Full Sync',
        customers: 'Customers',
        invoices: 'Invoices',
        payments: 'Payments',
        chartOfAccounts: 'Chart of Accounts',
      },

      metrics: {
        totalSyncs: 'Total Syncs',
        successRate: 'Success Rate',
        itemsSynced: 'Items Synced',
        failedSyncs: 'Failed Syncs',
        lastSync: 'Last sync',
        acrossAllOperations: 'Across all sync operations',
        reviewErrorLogs: 'Review error logs below',
      },

      quickSyncActions: {
        title: 'Quick Sync Actions',
        description: 'Sync specific data types individually',
      },

      syncHistory: {
        title: 'Sync History',
        description: 'Recent synchronization activities and their status',
        noHistory: 'No sync history available',

        tabs: {
          all: 'All',
          successful: 'Successful',
          failed: 'Failed',
        },

        table: {
          status: 'Status',
          type: 'Type',
          started: 'Started',
          duration: 'Duration',
          items: 'Items',
          error: 'Error',
        },
      },

      messages: {
        syncCompleted: '{type} sync completed successfully',
        syncFailed: 'Sync failed',
      },
    },

    // Banking pages
    bankingPages: {
      pageTitle: 'Bank Accounts',
      addBankAccount: 'Add Bank Account',
      comingSoon: 'Coming soon',
      noBankAccountsTitle: 'No bank accounts configured',
      noBankAccountsDesc: 'Add a bank account to import statements and auto-reconcile payments against invoices and bills.',
      addFirstAccount: 'Add your first bank account',
      columns: {
        name: 'Name',
        iban: 'IBAN',
        bank: 'Bank',
        currency: 'Currency',
        balance: 'Balance',
      },
      badges: {
        default: 'Default',
        inactive: 'Inactive',
        autoReconcileOn: 'Auto-reconcile on',
      },

      // Account detail page
      backToAccounts: 'Bank accounts',
      currentBalance: 'Current balance',
      unreconciled: 'Unreconciled',
      ofTransactions: 'of {total} transactions',
      lastImport: 'Last import',
      edit: 'Edit',
      deleteBankAccount: 'Delete bank account',
      autoReconcile: 'Auto-reconcile',
      importStatement: 'Import statement',
      noTransactionsYet: 'No transactions yet. Import a bank statement to get started.',
      allTransactions: 'All transactions',
      unreconciledFilter: 'Unreconciled',
      reconciledFilter: 'Reconciled',
      excludedFilter: 'Excluded',
      deleteConfirmTitle: 'Delete this bank account?',
      deleteConfirmDesc: 'This soft-deletes the bank account. Imported transactions are preserved but won\'t be visible in the UI. This action can be reversed in the database if needed.',
      delete: 'Delete',
      cancel: 'Cancel',
      bankAccountNotFound: 'Bank account not found.',

      // Import page
      importTitle: 'Import Bank Transactions',
      step1Title: 'Step 1: Select Bank Account',
      step2Title: 'Step 2: Upload Bank File',
      bankAccount: 'Bank Account',
      selectBankAccount: 'Select bank account',
      next: 'Next',
      back: 'Back',
      uploadDescription: 'Upload an MT940, CAMT.053 (XML), or CSV bank statement file. The format will be auto-detected.',
      clickToSelect: 'Click to select a file or drag and drop',
      importing: 'Importing...',
      import: 'Import',
      importFailed: 'Import failed: {error}',
      importCompleteTitle: 'Import Complete',
      formatDetected: 'Format detected:',
      totalParsed: 'Total parsed:',
      imported: 'Imported:',
      duplicatesSkipped: 'Duplicates skipped:',
      autoReconciled: 'Auto-reconciled:',
      parseErrors: 'Parse errors:',
      importAnother: 'Import Another',
      done: 'Done',

      // Reconciliation page
      reconciliationTitle: 'Bank Reconciliation',
      autoReconcileAll: 'Auto-Reconcile All',
      running: 'Running...',
      autoReconciledCount: 'Auto-reconciled {count} transactions',
      unreconciledTransactions: 'Unreconciled Transactions ({count})',
      allReconciled: 'All transactions reconciled!',
      matchSuggestions: 'Match Suggestions',
      selectTransaction: 'Select a Transaction',
      clickToSeeSuggestions: 'Click a transaction on the left to see matching suggestions.',
      noMatchesFound: 'No automatic matches found.',
      excludeTransaction: 'Exclude Transaction',
      reconcile: 'Reconcile',
      amount: 'Amount: {amount}',
      confidence: 'Confidence: {percent}%',

      // Rules page
      newRule: 'New Rule',
      noRulesTitle: 'No reconciliation rules yet. Create one to auto-categorize recurring transactions like rent, subscriptions, or bank fees.',
      createFirstRule: 'Create your first rule',
      deleteRuleTitle: 'Delete this rule?',
      deleteRuleDesc: 'Existing reconciled transactions are unaffected. New imports will no longer apply this rule.',
      columns_rules: {
        name: 'Name',
        priority: 'Priority',
        conditions: 'Conditions',
        actions: 'Actions',
        matches: 'Matches',
        lastMatched: 'Last matched',
        status: 'Status',
      },
      conditionsSummary: '{count} condition — {mode} must match',
      conditionsSummaryPlural: '{count} conditions — {mode} must match',
      ruleStatusActive: 'Active',
      ruleStatusInactive: 'Inactive',
      ruleActionEdit: 'Edit',
      ruleActionDelete: 'Delete',
      ruleNever: 'Never',

      // Transactions page
      transactionsTitle: 'Bank Transactions',
      transactionsSubtitle: 'Imported activity across all your bank accounts.',
      importStatementButton: 'Import statement',
      accountLabel: 'Account',
      statusLabel: 'Status',
      fromLabel: 'From',
      toLabel: 'To',
      searchLabel: 'Search',
      searchPlaceholder: 'Description, counterparty, reference…',
      allAccounts: 'All accounts',
      allStatuses: 'All statuses',
      noTransactionsMatch: 'No transactions match the selected filters.',
      transactionCount: '{count} transaction',
      transactionCountPlural: '{count} transactions',
      previous: 'Previous',
      next_page: 'Next',
      pageOf: 'Page {page} of {total}',
    },

    // Bill form (shared bill-form component)
    billForm: {
      billDetails: 'Bill Details',
      supplier: 'Supplier',
      selectSupplier: 'Select supplier',
      externalReference: 'External Reference',
      supplierInvoiceNumber: 'Supplier invoice number',
      issueDate: 'Issue Date',
      dueDate: 'Due Date',
      lineItems: 'Line Items',
      addLine: 'Add Line',
      description: 'Description',
      qty: 'Qty',
      unitPrice: 'Unit Price',
      discountPercent: 'Disc %',
      taxRate: 'Tax Rate',
      account: 'Account',
      lineTotal: 'Line Total',
      none: 'None',
      subtotal: 'Subtotal',
      tax: 'Tax',
      total: 'Total',
      notes: 'Notes',
      notesVisibleToSupplier: 'Notes (visible to supplier)',
      internalNotes: 'Internal Notes',
      saving: 'Saving...',
      createBill: 'Create Bill',
      updateBill: 'Update Bill',
      billNotFound: 'Bill not found.',
      backToBills: 'Back to bills',
      newBill: 'New Bill',
      editBill: 'Edit Bill {number}',
      prefilledFromOcr: 'Prefilled from OCR',
      ocrConfidence: '({percent}% confidence)',
      verifyValues: 'Please verify values before saving.',
    },

    // Bill detail page
    billDetail: {
      billNotFound: 'Bill not found.',
      backToBills: 'Back to bills',
      edit: 'Edit',
      approve: 'Approve',
      reject: 'Reject',
      supplier: 'Supplier',
      dates: 'Dates',
      issued: 'Issued:',
      due: 'Due:',
      reference: 'Reference',
      lineItems: 'Line Items',
      description: 'Description',
      qty: 'Qty',
      unitPrice: 'Unit Price',
      discountPercent: 'Disc %',
      tax: 'Tax',
      lineTotal: 'Line Total',
      noLineItems: 'No line items',
      subtotal: 'Subtotal',
      total: 'Total',
      paid: 'Paid',
      balanceDue: 'Balance Due',
      notes: 'Notes',
      internalNotes: 'Internal Notes',
      rejectBillTitle: 'Reject Bill',
      rejectBillDescription: 'Please provide a reason for rejecting this bill.',
      rejectReason: 'Reason',
      rejectReasonPlaceholder: 'Enter rejection reason...',
      cancel: 'Cancel',
      rejecting: 'Rejecting...',
      rejectConfirm: 'Reject',
    },

    // Contact/Customer pages
    contacts: {
      newContact: 'New Contact',
      editContact: 'Edit Contact',
      contactNotFound: 'Contact not found.',
      general: 'General',
      contactDetails: 'Contact Details',
      taxAndRegistration: 'Tax & Registration',
      bankingSection: 'Banking',
      payment: 'Payment',
      notes: 'Notes',
      role: 'Role',
      name: 'Name',
      firstName: 'First Name',
      lastName: 'Last Name',
      companyName: 'Company Name',
      email: 'Email',
      phone: 'Phone',
      btwNumber: 'BTW-nummer',
      kvkNumber: 'KvK Number',
      iban: 'IBAN',
      bic: 'BIC',
      paymentTermsDays: 'Payment Terms (days)',
      roles: {
        customer: 'Customer',
        supplier: 'Supplier',
        both: 'Customer + supplier',
      },
      creating: 'Creating...',
      saving: 'Saving...',
      createContact: 'Create Contact',
      saveChanges: 'Save Changes',
      cancel: 'Cancel',
      outstandingBalance: 'Outstanding Balance',
      financial: 'Financial',
      company: 'Company',
    },

    // Invoice detail page
    invoiceDetail: {
      invoiceNotFound: 'Invoice not found',
      downloadPdf: 'Download PDF',
      generatingPdf: 'Generating...',
      edit: 'Edit',
      send: 'Send',
      finalizing: 'Finalizing...',
      finalize: 'Finalize',
      recordPayment: 'Record Payment',
      contact: 'Contact',
      dates: 'Dates',
      issueDate: 'Issue Date',
      dueDate: 'Due Date',
      reference: 'Reference',
      lineItems: 'Line Items',
      description: 'Description',
      qty: 'Qty',
      unitPrice: 'Unit Price',
      discount: 'Discount',
      tax: 'Tax',
      total: 'Total',
      noLineItems: 'No line items',
      subtotal: 'Subtotal',
      amountPaid: 'Amount Paid',
      balanceDue: 'Balance Due',
      failedToPdf: 'Failed to generate PDF',
    },

    // Invoice dialog (create invoice)
    invoiceDialog: {
      newInvoice: 'New Invoice',
      createForCustomer: 'Create a new invoice for a customer.',
      customer: 'Customer',
      selectCustomer: 'Select a customer',
      searchCustomers: 'Search customers...',
      noCustomersFound: 'No customers found.',
      issueDate: 'Issue Date',
      dueDate: 'Due Date',
      reference: 'Reference',
      referencePlaceholder: 'PO number, project code, etc.',
      lineItems: 'Line Items',
      addItem: 'Add Item',
      itemNumber: 'Item {number}',
      descriptionPlaceholder: 'Description',
      qtyPlaceholder: 'Qty',
      unitPricePlaceholder: 'Unit price',
      taxRatePlaceholder: 'Tax rate',
      discountPlaceholder: 'Discount %',
      noTax: 'No tax',
      notes: 'Notes',
      notesPlaceholder: 'Payment instructions, thank-you message, etc.',
      subtotal: 'Subtotal',
      tax: 'Tax',
      total: 'Total',
      cancel: 'Cancel',
      creating: 'Creating...',
      createInvoice: 'Create Invoice',
      invoiceCreated: 'Invoice created successfully',
      failedToCreate: 'Failed to create invoice',
    },

    // Record payment dialog
    recordPayment: {
      title: 'Record Payment',
      amount: 'Amount',
      date: 'Date',
      paymentMethod: 'Payment Method',
      selectMethod: 'Select method',
      reference: 'Reference (optional)',
      cancel: 'Cancel',
      recording: 'Recording...',
      recordPayment: 'Record Payment',
      methods: {
        bankTransfer: 'Bank Transfer',
        cash: 'Cash',
        card: 'Card',
        ideal: 'iDEAL',
      },
    },

    // Send invoice dialog
    sendInvoice: {
      title: 'Send Invoice',
      sendToEmail: 'Send invoice to {email}?',
      noEmailFound: 'No email address found for this contact. Are you sure you want to mark this invoice as sent?',
      cancel: 'Cancel',
      sending: 'Sending...',
      send: 'Send',
    },

    // Invoice form (edit)
    invoiceForm: {
      editInvoice: 'Edit Invoice',
      newInvoice: 'New Invoice',
      invoiceNotFound: 'Invoice not found.',
      basicInformation: 'Basic Information',
      lineItems: 'Line Items',
      notes: 'Notes',
      customer: 'Customer',
      selectCustomer: 'Select a customer',
      issueDate: 'Issue Date',
      dueDate: 'Due Date',
      reference: 'Reference',
      referencePlaceholder: 'PO number, project code, etc.',
      itemNumber: 'Item {number}',
      description: 'Description',
      itemDescriptionPlaceholder: 'Item description',
      quantity: 'Quantity',
      unitPrice: 'Unit Price',
      taxRate: 'Tax Rate',
      noTax: 'None',
      discountPercent: 'Discount %',
      lineTotal: 'Line total:',
      addItem: 'Add Item',
      notesLabel: 'Notes (visible on invoice)',
      notesPlaceholder: 'Payment instructions, thank-you message, etc.',
      internalNotes: 'Internal Notes',
      internalNotesPlaceholder: 'Internal notes (not visible to the customer)',
      invoiceSummary: 'Invoice Summary',
      items: '{count} line item',
      itemsPlural: '{count} line items',
      subtotal: 'Subtotal',
      tax: 'Tax',
      total: 'Total',
      createInvoice: 'Create Invoice',
      updateInvoice: 'Update Invoice',
      backToInvoices: 'Back to Invoices',
      invoiceUpdated: 'Invoice updated successfully',
      invoiceCreated: 'Invoice created successfully',
      failedToSave: 'Failed to save invoice',
    },

    // Invoices list page
    invoicesPage: {
      searchPlaceholder: 'Search invoices...',
      newInvoice: 'New Invoice',
      groupOverdue: 'Overdue',
      groupSent: 'Sent',
      groupDraft: 'Draft',
      groupPaid: 'Paid',
      groupOther: 'Other',
      colNumber: 'Number',
      colContact: 'Contact',
      colDate: 'Date',
      colDueDate: 'Due Date',
      colTotal: 'Total',
      colStatus: 'Status',
      noInvoices: 'No invoices found',
    },

    // Journal entry pages
    journalEntry: {
      newEntry: 'New Journal Entry',
      entryDetails: 'Entry Details',
      journalLines: 'Journal Lines',
      date: 'Date',
      reference: 'Reference',
      referencePlaceholder: 'Optional reference',
      description: 'Description',
      descriptionPlaceholder: 'Entry description',
      account: 'Account',
      selectAccount: 'Select account',
      linePlaceholder: 'Line description',
      debit: 'Debit',
      credit: 'Credit',
      totals: 'Totals',
      addLine: 'Add Line',
      notBalanced: 'Entry is not balanced. Difference: {amount}',
      creating: 'Creating...',
      createEntry: 'Create Entry',
      cancel: 'Cancel',
      notFound: 'Journal entry not found.',
      postEntry: 'Post Entry',
      posting: 'Posting...',
      descriptionLabel: 'Description',
      sourceLabel: 'Source',
      totalsLabel: 'Totals',
      debitLabel: 'Debit:',
      creditLabel: 'Credit:',
      autoGenerated: 'Auto-generated',
      noLines: 'No lines',
    },

    // Journal entries list page
    journalPage: {
      newEntry: 'New Entry',
      ungrouped: 'Undated',
      colDate: 'Date',
      colReference: 'Reference',
      colDescription: 'Description',
      colDebit: 'Debit',
      colCredit: 'Credit',
      noEntries: 'No journal entries found',
    },

    // Reports pages
    reports: {
      title: 'Reports',
      profitLoss: 'Profit & Loss',
      profitLossDesc: 'Revenue, expenses, and net profit for a period',
      balanceSheet: 'Balance Sheet',
      balanceSheetDesc: 'Assets, liabilities, and equity at a point in time',
      trialBalance: 'Trial Balance',
      trialBalanceDesc: 'All account balances for verification',
      agedReceivables: 'Aged Receivables',
      agedReceivablesDesc: 'Outstanding customer invoices by age',
      agedPayables: 'Aged Payables',
      agedPayablesDesc: 'Outstanding supplier bills by age',
      cashFlow: 'Cash Flow',
      cashFlowDesc: 'Monthly inflows, outflows, and net cash flow',
      generalLedger: 'General Ledger',
      generalLedgerDesc: 'All transactions for a specific account',
      // Shared report UI
      from: 'From',
      to: 'To',
      asOf: 'As of',
      generate: 'Generate',
      loading: 'Loading...',
      noData: 'No data available.',
      account: 'Account',
      amount: 'Amount',
      total: 'Total',
      // Profit & Loss
      revenue: 'Revenue',
      expenses: 'Expenses',
      totalRevenue: 'Total Revenue',
      totalExpenses: 'Total Expenses',
      netProfitLoss: 'Net Profit / (Loss)',
      // Balance Sheet
      totalPrefix: 'Total',
      assets: 'Assets',
      liabilities: 'Liabilities',
      equity: 'Equity',
      // Trial Balance
      code: 'Code',
      debit: 'Debit',
      credit: 'Credit',
      totals: 'Totals',
      // Aged reports
      bucketCurrent: 'Current',
      bucket1_30: '1-30 days',
      bucket31_60: '31-60 days',
      bucket61_90: '61-90 days',
      bucketOver90: '90+ days',
      colInvoice: 'Invoice',
      colBill: 'Bill',
      colContact: 'Contact',
      colSupplier: 'Supplier',
      colDueDate: 'Due Date',
      colDaysOverdue: 'Days Overdue',
      colBalanceDue: 'Balance Due',
      noOutstandingReceivables: 'No outstanding receivables',
      noOutstandingPayables: 'No outstanding payables',
      // Cash Flow
      totalInflows: 'Total Inflows',
      totalOutflows: 'Total Outflows',
      netCashFlow: 'Net Cash Flow',
      monthlyBreakdown: 'Monthly Breakdown',
      colMonth: 'Month',
      colInflows: 'Inflows',
      colOutflows: 'Outflows',
      colNet: 'Net',
      colRunningBalance: 'Running Balance',
      // General Ledger
      selectAccount: 'Select an account',
      transactions: 'Transactions',
      colDate: 'Date',
      colEntryNumber: 'Entry #',
      colDescription: 'Description',
      colBalance: 'Balance',
      noTransactionsInPeriod: 'No transactions found for this period.',
      summary: 'Summary',
      openingBalance: 'Opening Balance',
      totalDebits: 'Total Debits',
      totalCredits: 'Total Credits',
      closingBalance: 'Closing Balance',
      accountType: 'Type:',
    },

    // Settings page
    settings: {
      title: 'Settings',
      companyDetails: 'Company Details',
      companyName: 'Company Name',
      companyNamePlaceholder: 'Company name',
      vatNumber: 'VAT Number',
      vatNumberPlaceholder: 'VAT number',
      chamberOfCommerce: 'Chamber of Commerce',
      cocPlaceholder: 'CoC number',
      iban: 'IBAN',
      ibanPlaceholder: 'IBAN',
      saveCompanyDetails: 'Save Company Details',
      numbering: 'Numbering',
      invoicePrefix: 'Invoice Prefix',
      nextInvoiceNumber: 'Next Invoice Number',
      saveNumbering: 'Save Numbering',
      emailInbox: 'Email Inbox',
      activeInbox: 'Active inbox:',
      autoScanEnabled: '(auto-scan enabled)',
      noInboxRegistered: 'Register an email address to receive invoices and documents directly into the accounting inbox.',
      inboxEmailPlaceholder: 'boekhouding@company.weldsuite.org',
      registering: 'Registering...',
      registerInbox: 'Register Inbox',
      inboxRegistered: 'Inbox registered successfully.',
      seedData: 'Seed Data',
      seedDataDesc: 'Seed the standard Dutch chart of accounts (RGS-based) to get started quickly.',
      seeding: 'Seeding...',
      seedDutchAccounts: 'Seed Dutch Accounts',
      xafTitle: 'Auditfile (XAF 4.0)',
      xafDesc: 'Export the XAF 4.0 auditfile for a fiscal year — the format the Belastingdienst requires during an audit (mandatory since 1 January 2026). Also useful for accountant handoff.',
      xafDownload: 'Download auditfile',
      xafDownloading: 'Generating…',
      seedWorkflowTemplates: 'Seed Workflow Templates',
      workflowsSeeded: 'Workflow templates seeded: {count} templates created.',
    },

    // VAT pages
    vat: {
      title: 'BTW-aangifte',
      newReturn: 'New VAT Return',
      period: 'Period',
      type: 'Type',
      status: 'Status',
      calculateReturn: 'Calculate VAT Return',
      periodType: 'Period Type',
      periodStart: 'Period Start',
      periodEnd: 'Period End',
      periodLabel: 'Period Label (optional)',
      periodLabelPlaceholder: 'e.g. Q1 2024',
      calculating: 'Calculating...',
      calculate: 'Calculate',
      cancel: 'Cancel',
      vatReturnTitle: 'BTW-aangifte {period}',
      periodTypeLabel: '{type} period',
      file: 'File',
      filing: 'Filing...',
      downloadXml: 'Download XML',
      checkStatus: 'Check status',
      returnsTitle: 'BTW-aangiftes',
      icpTitle: 'Opgaaf ICP (intracommunautaire prestaties)',
      icpDesc: 'Required alongside the BTW-aangifte whenever you had 0%-rated EU B2B supplies in the period.',
      icpNew: 'Calculate ICP',
      icpEmpty: 'No ICP declarations yet.',
      icpColTotal: 'Total supplies',
      icpColLines: 'Customers',
      icpFile: 'File',
      icpCalculated: 'ICP declaration calculated: {count} customer(s), {total} total',
      checkingStatus: 'Checking…',
      statusResult: 'Digipoort status: {status}',
      suppletieButton: 'Check suppletie',
      suppletieChecking: 'Comparing with ledger…',
      suppletieDeadlineLabel: 'Suppletie deadline',
      vatNotFound: 'VAT return not found.',
      r5a: 'Verschuldigd (5a)',
      r5b: 'Voorbelasting (5b)',
      r5f: 'Te betalen / te ontvangen (5f)',
      rubrieken: 'Rubrieken',
      noRubrieken: 'No rubrieken calculated yet.',
      periodTypes: {
        quarterly: 'Quarterly',
        monthly: 'Monthly',
        annual: 'Annual',
      },
      statuses: {
        draft: 'Draft',
        calculated: 'Calculated',
        filed: 'Filed',
        paid: 'Paid',
      },
      // VAT list page
      listNewReturn: 'Calculate New Return',
      listEmpty: 'No VAT returns found. Click "Calculate New Return" to create one.',
      colPeriod: 'Period',
      colType: 'Type',
      colR5a: 'Verschuldigd (5a)',
      colR5b: 'Voorbelasting (5b)',
      colR5f: 'Totaal (5f)',
      colStatus: 'Status',
      // VAT detail page
      filedSuccess: 'BTW-aangifte successfully filed',
      filingFailed: 'Filing failed: {error}',
      fileToTax: 'File to Belastingdienst',
      filingDetails: 'Filing Details',
      digipoortKenmerk: 'Digipoort Kenmerk',
      filedAt: 'Filed at',
      filedBy: 'Filed by',
      notesSection: 'Notes',
    },

    // Documents page
    documents: {
      title: 'Documents',
      upload: 'Upload',
      uploadDocument: 'Upload Document',
      uploadingDocument: 'Uploading Document',
      dragDropOrClick: 'Drag & drop or click to upload',
      acceptedFormats: 'Accepted formats: {formats}',
      uploading: 'Uploading...',
      uploadAndProcess: 'Upload & Process',
      cancel: 'Cancel',
      processing: 'Processing',
      pending: 'Pending',
      processed: 'Processed',
      review: 'Review',
      linked: 'Linked',
      rejected: 'Rejected',
      failed: 'Failed',
      statusFilter: 'Status',
      noDocuments: 'No documents yet.',
      columns: {
        file: 'File',
        type: 'Type',
        status: 'Status',
        actions: 'Actions',
      },
      actions: {
        view: 'View',
        createBill: 'Create Bill',
        scan: 'Re-scan',
        dismiss: 'Dismiss',
        linkContact: 'Link Contact',
      },
      // Upload zone & OCR
      dropHint: 'Drop invoice images here — WeldAgent will extract supplier, amounts, line items, and totals.',
      uploadInvoice: 'Upload invoice',
      noDocumentsInbox: 'No documents in inbox',
      phaseUploading: 'Uploading…',
      phaseProcessing: 'Scanning with WeldAgent…',
      phaseDone: 'Done',
      phaseFailed: 'Failed',
      // OCR result dialog
      ocrResult: 'OCR Result',
      colFileName: 'File Name',
      colType: 'Type',
      colSource: 'Source',
      colSupplierDetected: 'Supplier (detected)',
      colAmountDetected: 'Amount (detected)',
      colStatus: 'Status',
      groupPending: 'Pending',
      groupProcessing: 'Processing',
      groupReview: 'Review',
      groupProcessed: 'Processed',
      groupLinked: 'Linked',
      groupRejected: 'Rejected',
      groupOther: 'Other',
      ocrSupplier: 'Supplier',
      ocrMatched: 'Matched',
      ocrNoMatch: 'No match',
      ocrInvoiceDetails: 'Invoice Details',
      ocrLineItems: 'Line Items',
      ocrTotals: 'Totals',
      ocrConfidence: 'Confidence Scores',
      ocrOverall: 'Overall:',
      ocrSubtotal: 'Subtotal',
      ocrTotalTax: 'Total Tax',
      ocrTotal: 'Total',
      ocrColDescription: 'Description',
      ocrColQty: 'Qty',
      ocrColPrice: 'Price',
      ocrColVat: 'VAT %',
      ocrColTotal: 'Total',
      ocrFieldNumber: 'Number:',
      ocrFieldDate: 'Date:',
      ocrFieldDueDate: 'Due Date:',
      ocrFieldCurrency: 'Currency:',
      ocrFieldReference: 'Reference:',
      ocrFieldPaymentIban: 'Payment IBAN:',
      ocrFieldName: 'Name:',
      ocrFieldAddress: 'Address:',
      ocrFieldBtw: 'BTW-nummer:',
      ocrFieldKvk: 'KvK-nummer:',
      ocrFieldIban: 'IBAN:',
      reject: 'Reject',
      createSupplier: 'Create supplier',
      createBill: 'Create bill',
      createSupplierFromOcr: 'Create supplier from OCR',
      supplierName: 'Name',
      supplierBtw: 'BTW-nummer',
      supplierKvk: 'KvK-nummer',
      supplierIban: 'IBAN',
      supplierAddress: 'Address',
      creating: 'Creating…',
      processWithOcr: 'Process with OCR',
      viewOcrResult: 'View OCR result',
      acceptedFormatsLabel: 'JPG, PNG, WEBP',
      ocrVatLine: 'VAT {rate}% over {amount}',
    },

    // Entities page
    entities: {
      title: 'Administrations',
      newEntity: 'New Administration',
      entityName: 'Name',
      entityCountry: 'Country',
      entityCurrency: 'Currency',
      entityDescription: 'Description',
      noEntities: 'No administrations configured.',
      creating: 'Creating...',
      createEntity: 'Create Administration',
      cancel: 'Cancel',
      notFound: 'Administration not found.',
      addEntityTitle: 'New Administration',
      basicDetails: 'Basic Details',
      financialSettings: 'Financial Settings',
      namePlaceholder: 'My Company BV',
      descriptionPlaceholder: 'Main business entity...',
      legalName: 'Legal Name',
      legalNamePlaceholder: 'My Company B.V.',
      taxId: 'Tax ID / VAT Number',
      taxIdPlaceholder: 'NL000000000B01',
      fiscalYearEnd: 'Fiscal Year End Month',
      // Entities list page
      colName: 'Name',
      colJurisdiction: 'Jurisdiction',
      colCurrency: 'Currency',
      colTaxIds: 'VAT / Registration',
      badgeDefault: 'Default',
      colKor: 'KOR',
      korEnabled: 'KOR active — no BTW is charged and no BTW-aangifte is due',
      korDisabled: 'KOR off — normal BTW rules apply',
      korToggleOn: 'KOR enabled for this entity. Invoices will carry the exemption wording and BTW returns are blocked while active.',
      korToggleOff: 'KOR disabled. Normal BTW rules apply again from now on.',
      korUpdateFailed: 'Failed to update KOR setting',
      badgeInactive: 'Inactive',
      newEntity2: 'New Entity',
      noEntities2: 'No entities yet. Create one to start using WeldBooks.',
      // Add entity page
      newLegalEntity: 'New Legal Entity',
      newLegalEntityDesc: 'Creating an entity seeds its chart of accounts and tax rates from the jurisdiction adapter.',
      displayName: 'Display name',
      displayNamePlaceholder: 'WeldCorp BV',
      legalNamePlaceholder2: 'WeldCorp Besloten Vennootschap',
      entityType: 'Entity type',
      jurisdiction: 'Jurisdiction',
      baseCurrency: 'Base currency',
      vatNumber: 'VAT number',
      registrationNumber: 'Registration number (KVK / CoC / HRB)',
      ibanLabel: 'IBAN',
      makeDefault: 'Make this the workspace default entity',
      seedDefaults: 'Seed standard chart of accounts + tax rates for this jurisdiction',
      createEntity2: 'Create entity',
      creatingEntity: 'Creating…',
      failedToCreate: 'Failed to create entity',
    },

    // Recurring invoices list + detail pages
    recurringPage: {
      colContact: 'Contact',
      colFrequency: 'Frequency',
      colNextDate: 'Next Date',
      colAmount: 'Amount',
      colStatus: 'Status',
      statusActive: 'Active',
      statusPaused: 'Paused',
      newRecurring: 'New Recurring Invoice',
      noRecurring: 'No recurring invoices found',
      // Detail page
      notFound: 'Recurring invoice not found.',
      defaultName: 'Recurring Invoice',
      generating: 'Generating...',
      generateNow: 'Generate Now',
      pause: 'Pause',
      resume: 'Resume',
      generatedInvoice: 'Invoice generated: {number}',
      nextIssueDate: 'Next Issue Date',
      generatedCount: 'Generated Count',
      lastGenerated: 'Last Generated',
      never: 'Never',
      schedule: 'Schedule',
      frequency: 'Frequency',
      dayOfMonth: 'Day of Month',
      endDate: 'End Date',
      autoFinalize: 'Auto-finalize',
      autoSend: 'Auto-send',
      yes: 'Yes',
      no: 'No',
      templateItems: 'Template Items',
      // Add / edit
      addTitle: 'New Recurring Invoice',
      editTitle: 'Edit Recurring Invoice',
      comingSoon: 'Coming soon',
    },

    // Bills list page
    billsPage: {
      searchPlaceholder: 'Search bills...',
      newBill: 'New Bill',
      groupOverdue: 'Overdue',
      groupApproved: 'Approved',
      groupDraft: 'Draft',
      groupPaid: 'Paid',
      groupOther: 'Other',
      colNumber: 'Number',
      colSupplier: 'Supplier',
      colDate: 'Date',
      colDueDate: 'Due Date',
      colTotal: 'Total',
      colStatus: 'Status',
      noBills: 'No bills found',
    },

    // Accounts (Chart of Accounts) page
    accountsPage: {
      filterTypeLabel: 'Type',
      filterAsset: 'Asset',
      filterLiability: 'Liability',
      filterEquity: 'Equity',
      filterRevenue: 'Revenue',
      filterExpense: 'Expense',
      newAccount: 'New Account',
      groupAssets: 'Assets',
      groupLiabilities: 'Liabilities',
      groupEquity: 'Equity',
      groupRevenue: 'Revenue',
      groupExpenses: 'Expenses',
      colCode: 'Code',
      colName: 'Name',
      colType: 'Type',
      colBalance: 'Balance',
      noAccounts: 'No accounts found',
    },

    // Customers list page
    customersPage: {
      searchPlaceholder: 'Search customers...',
      newCustomer: 'New Customer',
      filterRoleLabel: 'Role',
      filterBoth: 'Customer + supplier (only)',
      colName: 'Name',
      colEmail: 'Email',
      colRole: 'Role',
      colVat: 'VAT Number',
      roleBoth: 'Customer + supplier',
      noCustomers: 'No customers found',
    },

    // Suppliers list page
    suppliersPage: {
      searchPlaceholder: 'Search suppliers...',
      newSupplier: 'New Supplier',
      filterRoleLabel: 'Role',
      filterBoth: 'Customer + supplier (only)',
      colName: 'Name',
      colEmail: 'Email',
      colRole: 'Role',
      colVat: 'VAT Number',
      roleBoth: 'Customer + supplier',
      noSuppliers: 'No suppliers found',
    },

    // Credit notes page
    creditNotesPage: {
      searchPlaceholder: 'Search credit notes...',
      colNumber: 'Number',
      colContact: 'Contact',
      colDate: 'Date',
      colForInvoice: 'For Invoice',
      colTotal: 'Total',
      colStatus: 'Status',
      viewSource: 'View source',
      noCreditNotes: 'No credit notes yet. Open a finalized invoice and use "Create credit note".',
    },

    // KPI cards
    kpiCards: {
      revenueMonth: 'Revenue (month)',
      revenueYear: 'Revenue (year)',
      expensesMonth: 'Expenses (month)',
      profitMonth: 'Profit (month)',
      outstandingReceivables: 'Outstanding Receivables',
      overdueReceivables: 'Overdue Receivables',
      outstandingPayables: 'Outstanding Payables',
      pendingDocuments: 'Pending Documents',
      invoices: '{count} invoices',
      bills: '{count} bills',
    },

    // Shared status badge labels used across multiple pages
    statusLabels: {
      // Invoice statuses (invoices/[id]/page, invoices/page, credit-notes/page)
      invoice: {
        draft: 'Draft',
        sent: 'Sent',
        paid: 'Paid',
        overdue: 'Overdue',
        partial: 'Partial',
        cancelled: 'Cancelled',
        finalized: 'Finalized',
        fallback: 'Invoice',
      },
      // Journal entry statuses (journal/[id]/page)
      journalEntry: {
        draft: 'Draft',
        posted: 'Posted',
        reversed: 'Reversed',
        fallback: 'Journal Entry',
        sourceManual: 'Manual',
      },
      // VAT return statuses not already covered by vat.statuses
      vatReturn: {
        calculated: 'Calculated',
        reviewed: 'Reviewed',
        accepted: 'Accepted',
        rejected: 'Rejected',
      },
      // Recurring invoice statuses (recurring/[id]/page)
      recurringInvoice: {
        active: 'Active',
        paused: 'Paused',
        ended: 'Ended',
      },
      // Generic fallback for unknown counterparty (banking/reconciliation/page)
      counterpartyUnknown: 'Unknown',
    },

    // WeldBooks layout
    layout: {
      appNotInstalled: 'App not installed',
    },

    // WeldBooks breadcrumb header segment labels
    header: {
      weldbooks: 'WeldBooks',
      invoices: 'Invoices',
      creditNotes: 'Credit Notes',
      bills: 'Bills',
      recurring: 'Recurring Invoices',
      contacts: 'Contacts',
      accounts: 'Chart of Accounts',
      journal: 'Journal Entries',
      vat: 'VAT Returns',
      banking: 'Banking',
      transactions: 'Transactions',
      reconciliation: 'Reconciliation',
      rules: 'Rules',
      import: 'Import',
      documents: 'Documents',
      customers: 'Customers',
      suppliers: 'Suppliers',
      entities: 'Entities',
      reports: 'Reports',
      profitLoss: 'P&L',
      balanceSheet: 'Balance Sheet',
      trialBalance: 'Trial Balance',
      agedReceivables: 'Aged Receivables',
      agedPayables: 'Aged Payables',
      cashFlow: 'Cash Flow',
      generalLedger: 'General Ledger',
      settings: 'Settings',
      dashboard: 'Dashboard',
      add: 'New',
      edit: 'Edit',
      detail: 'Detail',
    },
  };
