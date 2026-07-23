export const accounting = {
    title: 'Boekhouding',
    description: 'Beheer uw financiële administratie en rapportage',

    // Sidebar Navigation
    sidebar: {
      groups: {
        dashboard: 'Dashboard',
        bookkeeping: 'Boekhouding',
        sales: 'Verkoop',
        purchases: 'Inkoop',
        banking: 'Bank',
        projects: 'Projecten',
        integrations: 'Integraties',
        management: 'Beheer',
      },
      items: {
        overview: 'Overzicht',
        reports: 'Rapporten',
        chartOfAccounts: 'Rekeningschema',
        journalEntries: 'Journaalposten',
        generalLedger: 'Grootboek',
        invoices: 'Facturen',
        customers: 'Klanten',
        productsServices: 'Producten & Diensten',
        bills: 'Inkoopfacturen',
        vendors: 'Leveranciers',
        expenses: 'Uitgaven',
        bankAccounts: 'Bankrekeningen',
        transactions: 'Transacties',
        reconciliation: 'Bankafstemmingen',
        projects: 'Projecten',
        timeTracking: 'Tijdregistratie',
        milestones: 'Mijlpalen',
        integrations: 'Integraties',
        budgets: 'Budgetten',
        sequences: 'Nummerreeksen',
        btwAangifte: 'BTW-aangifte',
        taxSettings: 'Belastinginstellingen',
        companySettings: 'Bedrijfsinstellingen',
      },
    },

    accounts: {
      title: 'Rekeningschema',
      pageDescription: 'Beheer uw grootboekrekeningen en rekeninghiërarchie',
      account: 'Rekening',
      accountCode: 'Rekeningcode',
      accountName: 'Rekeningnaam',
      description: 'Omschrijving',
      createAccount: 'Rekening Aanmaken',
      editAccount: 'Rekening Bewerken',
      backToAccounts: 'Terug naar Rekeningen',

      // Form sections
      basicInformation: 'Basisinformatie',
      classification: 'Classificatie',
      openingBalance: 'Openingssaldo',
      settings: 'Instellingen',

      // Form labels
      code: 'Rekeningcode *',
      name: 'Rekeningnaam *',
      descriptionPlaceholder: 'Rekening omschrijving...',
      type: 'Rekeningtype *',
      subtype: 'Subtype',
      subtypePlaceholder: 'Vlottende Activa',
      openingBalanceAmount: 'Openingssaldo Bedrag',
      currency: 'Valuta',
      isActive: 'Actief',

      // Info texts
      numberingSchemeInfo: 'Gebruik een systematisch nummeringssysteem: 1000-1999 voor Activa, 2000-2999 voor Passiva, 3000-3999 voor Eigen Vermogen, 4000-4999 voor Opbrengsten, 5000-9999 voor Kosten.',
      accountCodeTooltip: 'Voer een unieke rekeningcode in (bijv. 1000-9999)',

      // Account types
      types: {
        asset: 'Actief',
        assets: 'Activa',
        liability: 'Passief',
        liabilities: 'Passiva',
        equity: 'Eigen Vermogen',
        revenue: 'Opbrengst',
        expense: 'Kost',
        expenses: 'Kosten'
      },

      // Account type descriptions
      typeDescriptions: {
        asset: 'Middelen in eigendom van het bedrijf (kas, voorraad, apparatuur)',
        liability: 'Schulden van het bedrijf (leningen, crediteuren)',
        equity: 'Aandeel van de eigenaar in het bedrijf',
        revenue: 'Inkomsten uit bedrijfsactiviteiten',
        expense: 'Kosten van bedrijfsvoering',
      },

      // Currency options
      currencies: {
        usd: 'USD - Amerikaanse Dollar',
        eur: 'EUR - Euro',
        gbp: 'GBP - Britse Pond',
      },

      // Actions
      actions: {
        addAccount: 'Rekening Toevoegen',
        importAccounts: 'Rekeningen Importeren',
        save: 'Rekening Opslaan',
        cancel: 'Annuleren',
      },

      // Messages
      messages: {
        validationError: 'Validatiefout',
        codeAndNameRequired: 'Rekeningcode en naam zijn verplicht',
        accountCreated: 'Rekening succesvol aangemaakt!',
        accountUpdated: 'Rekening succesvol bijgewerkt!',
        accountCreatedDesc: '{name} is toegevoegd aan het rekeningschema.',
        accountUpdatedDesc: '{name} is bijgewerkt.',
        error: 'Fout',
        failedToSave: 'Rekening opslaan mislukt',
        failedToCreate: 'Rekening aanmaken mislukt',
        failedToUpdate: 'Rekening bijwerken mislukt',
      },

      // Summary
      accountSummary: 'Rekening Overzicht',
      untitledAccount: 'Naamloze Rekening',
      accountType: 'Rekeningtype',
      status: 'Status',
      active: 'Actief',
      inactive: 'Inactief',

      // Summary field labels
      summaryCode: 'Code',
      summaryName: 'Naam',
      summaryType: 'Type',
      summarySubtype: 'Subtype',
      summaryOpeningBalance: 'Openingssaldo',

      // Additional UI strings
      saveChanges: 'Wijzigingen Opslaan',
      statusTooltip: 'Inactieve rekeningen verschijnen niet in transactieformulieren',
      editing: 'Bewerken',

      // Page-level additions
      newAccount: 'Nieuwe Rekening',
      accountDetails: 'Rekeninggegevens',
      financial: 'Financieel',
      normalSide: 'Normale Kant',
      debit: 'Debet',
      credit: 'Credit',
      currentBalance: 'Huidig Saldo',
      balances: 'Saldi',
      notFound: 'Rekening niet gevonden.',
      creating: 'Aanmaken...',
      saving: 'Opslaan...',
      cancel: 'Annuleren',
      codePlaceholder: 'bijv. 1000',
      selectSubtype: 'Selecteer subtype',
      system: 'Systeem',

      // Subtype labels
      subtypeLabels: {
        currentAsset: 'Vlottend Actief',
        fixedAsset: 'Vast Actief',
        bank: 'Bank',
        cash: 'Kas',
        accountsReceivable: 'Debiteuren',
        inventory: 'Voorraad',
        prepaidExpense: 'Vooruitbetaalde Kosten',
        currentLiability: 'Vlottende Passiva',
        longTermLiability: 'Langlopende Passiva',
        accountsPayable: 'Crediteuren',
        taxPayable: 'Te Betalen Belasting',
        creditCard: 'Creditcard',
        ownersEquity: 'Eigen Vermogen Eigenaar',
        retainedEarnings: 'Ingehouden Winst',
        shareCapital: 'Aandelenkapitaal',
        sales: 'Verkoop',
        otherIncome: 'Overige Opbrengsten',
        interestIncome: 'Rente-inkomsten',
        serviceRevenue: 'Dienstenomzet',
        operatingExpense: 'Bedrijfskosten',
        costOfGoodsSold: 'Kostprijs Verkochte Goederen',
        payroll: 'Salariskosten',
        depreciation: 'Afschrijving',
        interestExpense: 'Rentekosten',
        taxExpense: 'Belastingkosten',
      },
    },

    administrations: {
      detailsDialog: {
        title: 'Administratie Details',
        description: 'Bekijk configuratiedetails voor {name}',

        labels: {
          administrationName: 'Administratienaam',
          country: 'Land',
          currency: 'Valuta',
          language: 'Taal',
          timezone: 'Tijdzone',
          accountingStandard: 'Boekhoudstandaard',
          fiscalYearStart: 'Start Boekjaar',
          taxSettings: 'Belastinginstellingen',
          reportingRequirements: 'Rapportagevereisten',
          chartOfAccountsTemplate: 'Rekeningschema Sjabloon',
          created: 'Aangemaakt',
          lastUpdated: 'Laatst Bijgewerkt',
        },

        status: {
          active: 'Actief',
          inactive: 'Inactief',
        },

        unknown: 'Onbekend',
      },
    },

    generalLedger: {
      title: 'Grootboek',
      labels: {
        debits: 'Debiteringen',
        credits: 'Crediteringen',
        entries: 'Posten',
        accounts: 'Rekeningen'
      },
      actions: {
        newEntry: 'Nieuwe Post'
      }
    },
    expenses: {
      title: 'Uitgaven'
    },
    receivables: {
      title: 'Debiteuren'
    },
    payables: {
      title: 'Crediteuren'
    },
    dashboard: {
      title: 'Boekhouding Dashboard',
      bankAccounts: 'Bankrekeningen',
      noBankAccounts: 'Geen bankrekeningen geconfigureerd.',
      upcomingDue: 'Aankomende Vervaldatums',
      noUpcomingInvoices: 'Geen aankomende facturen.',
      recentPayments: 'Recente Betalingen',
      noRecentPayments: 'Geen recente betalingen.',
      loadingMessage: 'Dashboard wordt geladen. Als dit aanhoudt, probeer dan te vernieuwen.',
      table: {
        invoice: 'Factuur',
        contact: 'Contactpersoon',
        due: 'Vervaldatum',
        amount: 'Bedrag',
        date: 'Datum',
        type: 'Type',
        method: 'Methode',
        reference: 'Referentie',
      },
    },

    journal: {
      title: 'Journaalposten',
      status: {
        posted: 'Geboekt',
        draft: 'Concept'
      },
      actions: {
        createEntry: 'Post Aanmaken',
        importEntries: 'Posten Importeren'
      },
      errors: {
        unableToLoad: 'Kan journaalposten niet laden',
        apiConnection: 'Kan geen verbinding maken met de API'
      }
    },
    recurringEntries: {
      title: 'Terugkerende Boekingen',
      status: {
        active: 'Actief',
        paused: 'Gepauzeerd'
      },
      frequency: {
        daily: 'Dagelijks',
        weekly: 'Wekelijks',
        monthly: 'Maandelijks'
      },
      actions: {
        createEntry: 'Terugkerende Boeking Aanmaken'
      },
      notFound: 'Terugkerende boeking niet gevonden.',
      editEntry: 'Terugkerende Boeking Bewerken',
      newEntry: 'Nieuwe Terugkerende Boeking',
      saving: 'Opslaan...',
      creating: 'Aanmaken...',
    },

    currencyManagement: {
      title: 'Valutabeheer',
      subtitle: 'Beheer wisselkoersen en valuta-instellingen',
      addCurrency: 'Valuta Toevoegen',
      currency: 'Valuta',
      selectCurrency: 'Selecteer een valuta...',
      selectCurrencyDescription: 'Selecteer een valuta om toe te voegen aan uw administratie',
      setAsDefault: 'Instellen als standaardvaluta',
      setAsDefaultDescription: 'Maak dit uw hoofdvaluta voor rapporten',
      cancel: 'Annuleren',
      adding: 'Toevoegen...',

      // Stats
      activeCurrencies: 'Actieve Valuta\'s',
      currentlyEnabled: 'Momenteel ingeschakeld',
      inactive: 'Inactief',
      disabledCurrencies: 'Uitgeschakelde valuta\'s',
      defaultCurrency: 'Standaardvaluta',
      baseForReports: 'Basis voor rapporten',
      totalCurrencies: 'Totaal Valuta\'s',
      inSystem: 'In systeem',

      // Exchange rates
      recentExchangeRateActivity: 'Recente Wisselkoers Activiteit',
      viewHistory: 'Bekijk Geschiedenis',
      euroToUsDollar: 'Euro naar US Dollar',
      britishPoundToUsDollar: 'Britse Pond naar US Dollar',
      japaneseYenToUsDollar: 'Japanse Yen naar US Dollar',

      // Primary currency
      primaryCurrency: 'Primaire Valuta',
      allFinancialReportsCalculated: 'Alle financiële rapporten en analyses worden berekend in deze valuta',
      baseRate: 'Basiskoers',
      updateRates: 'Koersen Bijwerken',

      // No administration state
      noWorkspaceSelected: 'Geen Werkruimte Geselecteerd',
      selectWorkspaceMessage: 'Selecteer een werkruimte uit het dropdown menu hierboven om valuta\'s en wisselkoersen te beheren',
    },

    assets: {
      title: 'Activa',
      createAsset: 'Activum Aanmaken',
      editAsset: 'Activum Bewerken',
      backToAssets: 'Terug naar Activa',

      // Sections
      assetInformation: 'Activuminformatie',
      physicalDetails: 'Fysieke Details',
      assignment: 'Toewijzing',
      financialDetails: 'Financiële Details',
      depreciationSummary: 'Afschrijvingsoverzicht',

      // Form labels
      assetNumber: 'Activumnummer',
      assetName: 'Activumnaam',
      status: 'Status',
      description: 'Beschrijving',
      category: 'Categorie',
      assetType: 'Activumtype',
      serialNumber: 'Serienummer',
      manufacturer: 'Fabrikant',
      model: 'Model',
      acquisitionDate: 'Aanschafdatum',
      warrantyExpiry: 'Garantie Vervaldatum',
      location: 'Locatie',
      department: 'Afdeling',
      responsiblePerson: 'Verantwoordelijke Persoon',
      acquisitionCost: 'Aanschafkosten',
      residualValue: 'Restwaarde',
      usefulLifeYears: 'Gebruiksduur (Jaren)',
      depreciationMethod: 'Afschrijvingsmethode',
      depreciationStartDate: 'Afschrijving Startdatum',
      notes: 'Aanvullende Opmerkingen',

      // Placeholders
      assetNamePlaceholder: 'bijv., Dell XPS 15 Laptop',
      descriptionPlaceholder: 'Gedetailleerde beschrijving van het activum...',
      assetTypePlaceholder: 'bijv., Laptop, Vorkheftruck, etc.',
      notesPlaceholder: 'Eventuele aanvullende opmerkingen over dit activum...',
      selectStatus: 'Selecteer status',
      selectCategory: 'Selecteer categorie',
      selectLocation: 'Selecteer locatie',
      selectDepartment: 'Selecteer afdeling',
      selectEmployee: 'Selecteer medewerker',
      searchLocation: 'Zoek locatie...',
      searchDepartment: 'Zoek afdeling...',
      searchEmployee: 'Zoek medewerker...',

      // Statuses
      statuses: {
        pending: 'In Behandeling',
        active: 'Actief',
        underMaintenance: 'In Onderhoud',
        disposed: 'Afgestoten',
        writtenOff: 'Afgeschreven',
      },

      // Categories
      categories: {
        buildings: 'Gebouwen',
        vehicles: 'Voertuigen',
        equipment: 'Apparatuur',
        furniture: 'Meubilair',
        hardware: 'Hardware',
        software: 'Software',
        land: 'Grond',
        machinery: 'Machines',
      },

      // Depreciation methods
      depreciationMethods: {
        straightLine: 'Lineair',
        decliningBalance: 'Degressief',
        unitsOfProduction: 'Productie-eenheden',
      },

      // Depreciation summary
      depreciableAmount: 'Af te schrijven Bedrag',
      depreciationRate: 'Afschrijvingspercentage',
      monthlyDepreciation: 'Maandelijkse Afschrijving',
      annualDepreciation: 'Jaarlijkse Afschrijving',
      yearsLabel: 'jaar',
      usefulLife: 'Gebruiksduur',
      name: 'Naam',
      acquired: 'Aangeschaft',
      assetSummary: 'Activum Overzicht',

      // Search/Selection
      noLocationFound: 'Geen locatie gevonden',
      noDepartmentFound: 'Geen afdeling gevonden',
      noEmployeeFound: 'Geen medewerker gevonden',

      // Actions
      createAssetButton: 'Activum Aanmaken',
      updateAssetButton: 'Activum Bijwerken',
      cancel: 'Annuleren',
      saving: 'Opslaan...',

      // Messages
      validationError: 'Validatiefout',
      fillRequiredFields: 'Vul alle verplichte velden in',
      enterAssetName: 'Voer een activumnaam in',
      enterValidAcquisitionCost: 'Voer geldige aanschafkosten in',
      selectLocationRequired: 'Selecteer een locatie',
      selectDepartmentRequired: 'Selecteer een afdeling',
      assetCreated: 'Activum {assetNumber} succesvol aangemaakt',
      assetUpdated: 'Activum succesvol bijgewerkt!',
      failedToCreate: 'Aanmaken activum mislukt',
      failedToUpdate: 'Bijwerken activum mislukt',
      unexpectedError: 'Er is een onverwachte fout opgetreden',
    },

    bills: {
      title: 'Facturen',
      createBill: 'Factuur Aanmaken',
      editBill: 'Factuur Bewerken',
      backToBills: 'Terug naar Facturen',

      // Sections
      billInformation: 'Factuurinformatie',
      vendorInformation: 'Leveranciersinformatie',
      lineItems: 'Regelitems',
      billSummary: 'Factuur Overzicht',

      // Form labels
      billNumber: 'Factuurnummer',
      status: 'Status',
      billDate: 'Factuurdatum',
      dueDate: 'Vervaldatum',
      referenceNumber: 'Referentienummer',
      paymentTerms: 'Betalingsvoorwaarden',
      vendor: 'Leverancier',
      vendorName: 'Leveranciersnaam',
      selectVendorLabel: 'Selecteer Leverancier *',
      description: 'Beschrijving',
      quantity: 'Aantal',
      unitPrice: 'Eenheidsprijs',
      taxRate: 'BTW %',
      amount: 'Bedrag',
      account: 'Onkostenrekening',
      notes: 'Opmerkingen',
      additionalNotes: 'Aanvullende Opmerkingen',

      // Placeholders
      billNumberPlaceholder: 'FACT-001',
      referenceNumberPlaceholder: 'PO-12345 of Factuur #...',
      selectStatus: 'Selecteer status',
      selectDate: 'Selecteer datum',
      selectPaymentTerms: 'Selecteer betalingsvoorwaarden',
      selectVendor: 'Selecteer een leverancier...',
      selectAccount: 'Selecteer rekening...',
      searchVendor: 'Zoek leveranciers...',
      searchAccount: 'Zoek onkostenrekeningen...',
      descriptionPlaceholder: 'Item beschrijving',
      notesPlaceholder: 'Voeg opmerkingen toe over deze factuur...',
      notesPlaceholderLong: 'Voer speciale instructies, betalingsopmerkingen of interne opmerkingen in...',
      vendorNamePlaceholder: 'ACME Corporation',
      vendorTaxIdPlaceholder: 'XX-XXXXXXX',
      vendorEmailPlaceholder: 'leverancier@example.com',
      vendorPhonePlaceholder: '+31 (555) 123-4567',
      streetAddressPlaceholder: 'Hoofdstraat 123',
      cityPlaceholder: 'Amsterdam',
      stateProvincePlaceholder: 'NH',
      postalCodePlaceholder: '1012 AB',
      countryPlaceholder: 'Nederland',

      // Payment Terms
      paymentTermsOptions: {
        net15: 'Netto 15',
        net30: 'Netto 30',
        net45: 'Netto 45',
        net60: 'Netto 60',
        dueOnReceipt: 'Bij Ontvangst',
        cod: 'Rembours',
      },

      // Statuses
      statuses: {
        draft: 'Concept',
        pending: 'In Behandeling',
        approved: 'Goedgekeurd',
        paid: 'Betaald',
        cancelled: 'Geannuleerd',
      },

      // Line items
      addItem: 'Item Toevoegen',
      addLineItem: 'Regelitem Toevoegen',
      removeLineItem: 'Verwijderen',
      lineItemsCount: '{count} regelitem',
      lineItemsCountPlural: '{count} regelitems',
      noItemsAdded: 'Geen items toegevoegd',
      addItemsToStart: 'Voeg onkostenposten toe om uw factuur op te bouwen',

      // Table columns
      accountColumn: 'Rekening',
      descriptionColumn: 'Beschrijving',
      qtyColumn: 'Aantal',
      unitPriceColumn: 'Eenheidsprijs',
      taxColumn: 'BTW',
      amountColumn: 'Bedrag',

      // Summary labels
      subtotal: 'Subtotaal',
      tax: 'BTW',
      total: 'Totaal',
      totalItems: 'Totaal Items',
      totalItemsCount: '{count} totaal items',
      billDateLabel: 'Factuurdatum:',
      dueLabel: 'Vervaldatum:',

      // Vendor info
      noVendorFound: 'Geen leverancier gevonden',
      noVendorSelected: 'Geen leverancier geselecteerd',
      selectVendorFirst: 'Selecteer eerst een leverancier',
      noVendorsAvailable: 'Geen leveranciers beschikbaar',
      addVendorsFirst: 'Voeg eerst leveranciers toe aan uw account',
      vendorContact: 'Contact',
      vendorContactName: 'Contactpersoon',
      vendorEmail: 'E-mail',
      vendorPhone: 'Telefoon',
      vendorTaxId: 'BTW-nummer',
      vendorAddress: 'Leveranciersadres',
      streetAddress: 'Straatnaam',
      city: 'Stad',
      stateProvince: 'Provincie',
      postalCode: 'Postcode',
      country: 'Land',

      // Account info
      noAccountFound: 'Geen rekeningen gevonden.',
      accountBalance: 'Saldo',

      // Actions
      createBillButton: 'Factuur Aanmaken',
      updateBillButton: 'Factuur Bijwerken',
      cancel: 'Annuleren',
      saving: 'Opslaan...',
      creatingBill: 'Factuur Aanmaken...',

      // Messages
      validationError: 'Validatiefout',
      selectVendorRequired: 'Selecteer een leverancier',
      addAtLeastOneItem: 'Voeg minimaal één regelitem toe',
      billCreated: 'Factuur {billNumber} succesvol aangemaakt',
      billUpdated: 'Factuur succesvol bijgewerkt!',
      failedToCreate: 'Aanmaken factuur mislukt',
      failedToUpdate: 'Bijwerken factuur mislukt',
      unexpectedError: 'Er is een onverwachte fout opgetreden',

      // Stats
      stats: {
        totalBills: 'Totaal Inkoopfacturen',
        totalBillsDesc: 'Alle inkoopfacturen',
        overdue: 'Achterstallig',
        overdueDesc: 'Na vervaldatum',
        paidLabel: 'Betaald',
        paidDesc: 'Totaal betaald',
        pending: 'In Behandeling',
        pendingDesc: 'Wacht op betaling',
      },

      // Filters
      filters: {
        all: 'Alle',
        draft: 'Concept',
        pending: 'Wacht op Goedkeuring',
        approved: 'Goedgekeurd',
        unpaid: 'Onbetaald',
        paid: 'Betaald',
        overdue: 'Achterstallig',
      },

      // Table headers
      table: {
        billNumber: 'Factuur #',
        vendor: 'Leverancier',
        billDate: 'Factuurdatum',
        dueDate: 'Vervaldatum',
        status: 'Status',
        total: 'Totaal',
        balanceDue: 'Openstaand',
        unknownVendor: 'Onbekende Leverancier',
      },

      // Actions menu
      actionsMenu: {
        openMenu: 'Menu openen',
        actions: 'Acties',
        viewBill: 'Factuur Bekijken',
        submitForApproval: 'Indienen ter Goedkeuring',
        approveBill: 'Factuur Goedkeuren',
        recordPayment: 'Betaling Registreren',
        duplicate: 'Dupliceren',
        downloadPdf: 'PDF Downloaden',
        deleteBill: 'Verwijderen',
        confirmDelete: 'Weet u zeker dat u deze factuur wilt verwijderen? Deze actie kan niet ongedaan worden gemaakt.',
        duplicateFeature: 'Dupliceerfunctie komt binnenkort',
        pdfDownloadFeature: 'PDF-downloadfunctie komt binnenkort',
        paymentRecordingFeature: 'Betalingsregistratiefunctie komt binnenkort',
      },

      // Loading and empty states
      loadingBills: 'Inkoopfacturen laden...',
      selectAdministration: 'Selecteer een administratie om inkoopfacturen te bekijken.',
      noBillsFound: 'Geen inkoopfacturen gevonden.',

      // Additional status labels for bills (beyond the statuses object)
      statusLabels: {
        pendingApproval: 'Wacht op Goedkeuring',
        partiallyPaid: 'Gedeeltelijk Betaald',
        disputed: 'Betwist',
      },

      // Messages for list
      messages: {
        billStatusUpdated: 'Factuur {status} succesvol',
        updateFailed: 'Bijwerken factuur mislukt',
        billDeleted: 'Factuur succesvol verwijderd',
        deleteFailed: 'Verwijderen factuur mislukt',
      },
    },

    budgets: {
      title: 'Budgetten',
      createBudget: 'Budget Aanmaken',
      editBudget: 'Budget Bewerken',
      backToBudgets: 'Terug naar Budgetten',

      // Sections
      basicInformation: 'Basisinformatie',
      budgetOwner: 'Budgethouder',
      budgetAmountAndPeriod: 'Budgetbedrag & Periode',
      additionalInformation: 'Aanvullende Informatie',
      budgetSummary: 'Budget Overzicht',

      // Form labels
      budgetName: 'Budgetnaam',
      period: 'Periode',
      budgetType: 'Budgettype',
      department: 'Afdeling',
      description: 'Beschrijving',
      owner: 'Eigenaar *',
      approvalThreshold: 'Goedkeuringsdrempel',
      totalBudget: 'Totaal Budget',
      startDate: 'Startdatum',
      endDate: 'Einddatum',
      notes: 'Notities',

      // Placeholders
      budgetNamePlaceholder: 'Q1 2024 Operationeel Budget',
      periodPlaceholder: 'Q1 2024',
      selectDepartment: 'Selecteer afdeling',
      selectOwner: 'Selecteer eigenaar',
      descriptionPlaceholder: 'Beschrijf het doel en de omvang van dit budget...',
      approvalThresholdPlaceholder: '5000.00',
      totalBudgetPlaceholder: '500000.00',
      notesPlaceholder: 'Voeg aanvullende opmerkingen of speciale instructies toe...',

      // Budget Types
      budgetTypes: {
        operational: 'Operationeel',
        project: 'Project',
        capital: 'Kapitaal',
        strategic: 'Strategisch',
      },

      // Departments
      departments: {
        companyWide: 'Bedrijfsbreed',
        sales: 'Verkoop',
        marketing: 'Marketing',
        operations: 'Operaties',
        it: 'IT',
        hr: 'Human Resources',
        finance: 'Financiën',
        rd: 'Onderzoek & Ontwikkeling',
      },

      // Settings
      requireApproval: 'Goedkeuring Vereist',
      requireApprovalDesc: 'Alle uitgaven moeten worden goedgekeurd voordat ze worden verwerkt',
      allowOverspend: 'Overbesteding Toestaan',
      allowOverspendDesc: 'Sta uitgaven toe die het toegewezen budget overschrijden',
      activateImmediately: 'Direct Activeren',
      activateImmediatelyDesc: 'Stel dit budget direct actief in bij aanmaak',
      approvalThresholdHelp: 'Uitgaven boven dit bedrag vereisen goedkeuring',

      // Summary labels
      type: 'Type',
      approval: 'Goedkeuring:',
      notSet: 'Niet ingesteld',

      // Actions
      createBudgetButton: 'Budget Aanmaken',
      updateBudgetButton: 'Budget Bijwerken',
      cancel: 'Annuleren',
      creatingBudget: 'Budget Aanmaken...',
      saving: 'Opslaan...',

      // Messages
      fillRequired: 'Vul alle verplichte velden in',
      selectDates: 'Selecteer start- en einddatum',
      budgetCreated: 'Budget succesvol aangemaakt',
      budgetUpdated: 'Budget succesvol bijgewerkt',
      failedToCreate: 'Aanmaken budget mislukt',
      failedToUpdate: 'Bijwerken budget mislukt',
    },

    cashEntries: {
      title: 'Kasboek',
      newCashEntry: 'Nieuwe Kasboeking',
      editCashEntry: 'Kasboeking Bewerken',
      backToCashEntries: 'Terug naar kasboek',

      // Sections
      entryInformation: 'Boekingsinformatie',
      entryInformationDesc: 'Basisgegevens over de kastransactie',
      transactionDetails: 'Transactiedetails',
      transactionDetailsDesc: 'Aanvullende informatie over de transactie',
      additionalNotes: 'Aanvullende Opmerkingen',
      additionalNotesDesc: 'Optionele opmerkingen over deze kasboeking',
      entrySummary: 'Boeking Overzicht',

      // Form labels
      date: 'Datum',
      referenceNumber: 'Referentienummer',
      type: 'Type',
      amount: 'Bedrag',
      payeePayer: 'Ontvanger/Betaler',
      category: 'Categorie',
      description: 'Beschrijving',
      notes: 'Opmerkingen',

      // Placeholders
      referencePlaceholder: 'bijv., KAS-001',
      amountPlaceholder: '0.00',
      payeePlaceholder: 'Naam van persoon of bedrijf',
      selectCategory: 'Selecteer categorie',
      descriptionPlaceholder: 'Korte beschrijving van de transactie',
      notesPlaceholder: 'Voer aanvullende opmerkingen of details in...',

      // Types
      cashReceipt: 'Kas Ontvangst',
      cashPayment: 'Kas Betaling',
      receipt: 'Ontvangst',
      payment: 'Betaling',

      // Categories
      categories: {
        salesRevenue: 'Verkoopomzet',
        serviceIncome: 'Diensteninkomsten',
        customerRefunds: 'Klantterugbetalingen',
        officeSupplies: 'Kantoorbenodigdheden',
        utilities: 'Nutsvoorzieningen',
        rent: 'Huur',
        salariesWages: 'Salarissen & Lonen',
        equipmentPurchase: 'Apparatuuraankoop',
        other: 'Overig',
      },

      // Actions
      createCashEntry: 'Kasboeking Aanmaken',
      updateCashEntry: 'Kasboeking Bijwerken',
      recordCashEntry: 'Registreer een kasontvangst of betaling',

      // Messages
      enterValidAmount: 'Voer een geldig bedrag in',
      enterDescription: 'Voer een beschrijving in',
      cashEntryCreated: 'Kasboeking succesvol aangemaakt',
      cashEntryUpdated: 'Kasboeking succesvol bijgewerkt',
      failedToCreate: 'Aanmaken kasboeking mislukt',
      failedToUpdate: 'Bijwerken kasboeking mislukt',
    },

    vendors: {
      title: 'Leveranciers',
      createNewVendor: 'Nieuwe Leverancier Aanmaken',
      editVendor: 'Leverancier Bewerken',
      backToVendors: 'Terug naar leveranciers',
      vendorSummary: 'Leverancier Overzicht',

      // Sections
      basicInformation: 'Basisinformatie',
      basicInformationDesc: 'Bedrijfsgegevens en identificatie',
      contactInformation: 'Contactinformatie',
      contactInformationDesc: 'Primaire contactgegevens',
      addressInformation: 'Adresinformatie',
      addressInformationDesc: 'Bedrijfsadres',
      paymentDetails: 'Betalingsgegevens',
      paymentDetailsDesc: 'Betalingsvoorwaarden en bankinformatie',
      accountConfiguration: 'Accountconfiguratie',
      accountConfigurationDesc: 'Boekhoudinstellingen en categorisatie',
      additionalInformation: 'Aanvullende Informatie',
      additionalInformationDesc: 'Opmerkingen en tags',
      bankAccountInformation: 'Bankrekeninginformatie (Optioneel)',

      // Form labels
      vendorCode: 'Leverancierscode',
      taxId: 'BTW-nummer / Tax ID',
      companyName: 'Bedrijfsnaam',
      website: 'Website',
      primaryContact: 'Primair Contact',
      emailAddress: 'E-mailadres',
      phoneNumber: 'Telefoonnummer',
      streetAddress: 'Straatnaam',
      addressLine2: 'Adresregel 2',
      city: 'Stad',
      stateProvince: 'Provincie',
      postalCode: 'Postcode',
      country: 'Land',
      paymentTerms: 'Betalingsvoorwaarden',
      currency: 'Valuta',
      creditLimit: 'Kredietlimiet',
      bankName: 'Banknaam',
      routingNumber: 'Routingnummer',
      bankAccountNumber: 'Bankrekeningnummer',
      defaultExpenseAccount: 'Standaard Onkostenrekening',
      vendorCategory: 'Leverancierscategorie',
      tags: 'Tags',
      notes: 'Opmerkingen',

      // Placeholders
      taxIdPlaceholder: 'XX-XXXXXXX',
      companyPlaceholder: 'ACME Corporation',
      websitePlaceholder: 'https://example.com',
      contactPlaceholder: 'Jan Jansen',
      emailPlaceholder: 'leverancier@example.com',
      phonePlaceholder: '+31 (6) 12345678',
      streetAddressPlaceholder: 'Hoofdstraat 123',
      addressLine2Placeholder: 'Suite 100',
      cityPlaceholder: 'Amsterdam',
      postalCodePlaceholder: '1012 AB',
      selectState: 'Selecteer provincie',
      selectCountry: 'Selecteer land',
      selectPaymentTerms: 'Selecteer betalingsvoorwaarden',
      selectCurrency: 'Selecteer valuta',
      creditLimitPlaceholder: '10000.00',
      bankNamePlaceholder: 'ING Bank',
      routingPlaceholder: '021000021',
      bankAccountPlaceholder: 'XXXX-XXXX-XXXX',
      expenseAccountPlaceholder: 'Kosten:Operationeel',
      selectCategory: 'Selecteer categorie',
      tagsPlaceholder: 'Kommagescheiden tags (bijv., kantoorbenodigdheden, voorkeurspartner)',
      notesPlaceholder: 'Voer aanvullende opmerkingen over deze leverancier in...',

      // Payment Terms
      paymentTermsOptions: {
        net15: 'Netto 15',
        net30: 'Netto 30',
        net45: 'Netto 45',
        net60: 'Netto 60',
        dueOnReceipt: 'Bij Ontvangst',
        cod: 'Rembours',
        prepaid: 'Vooruitbetaald',
      },

      // Currencies
      currencies: {
        usd: 'USD - Amerikaanse Dollar',
        eur: 'EUR - Euro',
        gbp: 'GBP - Britse Pond',
        cad: 'CAD - Canadese Dollar',
        mxn: 'MXN - Mexicaanse Peso',
        cny: 'CNY - Chinese Yuan',
        jpy: 'JPY - Japanse Yen',
        inr: 'INR - Indiase Roepie',
      },

      // Vendor Categories
      categories: {
        supplier: 'Leverancier',
        contractor: 'Aannemer',
        serviceProvider: 'Dienstverlener',
        consultant: 'Consultant',
        utility: 'Nutsbedrijf',
      },

      // Settings
      active: 'Actief',
      preferred: 'Voorkeur',
      sendRemittance: 'Betalingsbewijs Verzenden',
      is1099Vendor: '1099 Leverancier (voor Amerikaanse belastingaangifte)',
      status: 'Status',
      preferredVendor: 'Voorkeurspartner',
      email: 'E-mail',
      phone: 'Telefoon',
      company: 'Bedrijf',

      // States
      noStatesAvailable: 'Geen provincies beschikbaar',
      inactive: 'Inactief',

      // Actions
      createVendor: 'Leverancier Aanmaken',
      updateVendor: 'Leverancier Bijwerken',

      // Messages
      companyNameRequired: 'Bedrijfsnaam is verplicht',
      provideEmailOrPhone: 'Geef een e-mailadres of telefoonnummer op',
      vendorCreated: 'Leverancier {vendorCode} succesvol aangemaakt',
      vendorUpdated: 'Leverancier succesvol bijgewerkt',
      failedToCreate: 'Aanmaken leverancier mislukt',
      failedToUpdate: 'Bijwerken leverancier mislukt',
      unexpectedError: 'Er is een onverwachte fout opgetreden',

      // List component
      loadingVendors: 'Leveranciers laden...',
      searchVendors: 'Zoek leveranciers...',
      vendorsCount: '{count} leveranciers',
      noVendorsFound: 'Geen leveranciers gevonden.',
      noVendorsSearch: 'Geen leveranciers gevonden die overeenkomen met uw zoekopdracht.',

      // Filters
      filters: {
        all: 'Alle',
        preferred: 'Voorkeurspartners',
      },

      // Table headers
      table: {
        vendor: 'Leverancier',
        contact: 'Contact',
        details: 'Details',
        activity: 'Activiteit',
        bills: 'Inkoopfacturen',
        totalSpent: 'Totaal Uitgegeven',
        outstanding: 'Openstaand',
        contactLabel: 'Contact:',
        termsLabel: 'Voorwaarden:',
        leadTime: 'Levertijd:',
        days: 'dagen',
        pos: 'PO\'s',
        lastActivity: 'Laatste:',
      },

      // Activity Status (reusing from customers)
      activityStatus: {
        active: 'Actief',
        inactive: 'Inactief',
        dormant: 'Inactief',
      },

      // Actions Menu
      actionsMenu: {
        openMenu: 'Menu openen',
        actions: 'Acties',
        viewDetails: 'Details Bekijken',
        editVendor: 'Leverancier Bewerken',
        visitWebsite: 'Website Bezoeken',
        deactivate: 'Deactiveren',
        confirmDeactivate: 'Weet u zeker dat u {name} wilt deactiveren? Ze worden verborgen uit de leverancierslijst, maar de gegevens blijven behouden.',
      },

      // Messages for list
      messages: {
        vendorDeactivated: 'Leverancier succesvol gedeactiveerd',
        deactivateFailed: 'Deactiveren leverancier mislukt',
      },

      // Stats component
      stats: {
        totalVendors: 'Totaal Leveranciers',
        totalVendorsDesc: 'Actieve leveranciers',
        preferred: 'Voorkeurslevanciers',
        preferredDesc: 'Voorkeurslevanciers',
        totalSpent: 'Totaal Uitgegeven',
        totalSpentDesc: 'Alle tijd uitgaven',
        outstanding: 'Openstaand',
        outstandingDesc: 'Onbetaalde facturen',
      },
    },

    currency: {
      title: 'Valuta',
      newCurrency: 'Nieuwe Valuta',
      currencySummary: 'Valuta Overzicht',

      // Sections
      currencyInformation: 'Valuta Informatie',
      exchangeRate: 'Wisselkoers',
      additionalSettings: 'Aanvullende Instellingen',

      // Form labels
      currencyCode: 'Valutacode',
      codeHelpText: 'ISO 4217 drieletterige code',
      currencyName: 'Valutanaam',
      symbol: 'Symbool',
      decimalPlaces: 'Decimalen',
      exchangeRateToBase: 'Wisselkoers naar Basisvaluta',
      exchangeRateHelpText: 'Koers waartegen deze valuta wordt omgezet naar uw basisvaluta',
      setAsBaseCurrency: 'Instellen als Basisvaluta',
      setAsBaseCurrencyDesc: 'Gebruik deze valuta als basisvaluta van uw bedrijf',
      activeCurrency: 'Actieve Valuta',
      activeCurrencyDesc: 'Schakel deze valuta in voor gebruik in transacties',

      // Decimal places options
      decimalOptions: {
        zero: '0 (geen decimalen)',
        two: '2 (standaard)',
        three: '3',
        four: '4',
      },

      // Placeholders
      codePlaceholder: 'EUR',
      namePlaceholder: 'Euro',
      symbolPlaceholder: '€',
      exchangeRatePlaceholder: '1.0000',
      notesPlaceholder: 'Voeg eventuele aanvullende opmerkingen over deze valuta toe...',

      // Summary labels
      code: 'Code',
      name: 'Naam',
      symbolLabel: 'Symbool',
      symbolDisplay: 'Symbool: {symbol}',
      active: 'Actief',
      inactive: 'Inactief',
      baseCurrency: 'Basisvaluta',

      // Actions and messages
      addCurrency: 'Valuta Toevoegen',
      addingCurrency: 'Valuta Toevoegen...',
      cancel: 'Annuleren',
      fillRequired: 'Vul alle verplichte velden in',
      enterValidRate: 'Voer een geldige wisselkoers in',
      currencyAdded: 'Valuta succesvol toegevoegd',
      failedToAdd: 'Valuta toevoegen mislukt',
    },

    directDebits: {
      title: 'Automatische Incasso',
      newDirectDebit: 'Nieuwe Automatische Incasso',
      debitSummary: 'Incasso Overzicht',

      // Sections
      basicInformation: 'Basisinformatie',
      vendorSelection: 'Leverancier Selectie',
      bankAccountAndMandate: 'Bankrekening & Machtiging',
      paymentSchedule: 'Betalingsschema',
      additionalSettings: 'Aanvullende Instellingen',

      // Form labels
      reference: 'Referentie',
      amount: 'Bedrag *',
      description: 'Omschrijving',
      descriptionPlaceholder: 'bijv., Maandelijkse abonnementsbetaling',
      selectVendor: 'Selecteer een leverancier...',
      searchVendors: 'Zoek leveranciers...',
      noVendorsFound: 'Geen leveranciers gevonden.',
      addVendorFirst: 'Voeg eerst een leverancier toe',
      selectedVendor: 'Geselecteerde Leverancier',
      accountNumber: 'Rekening',
      sortCode: 'Sorteercode',

      selectBankAccount: 'Selecteer bankrekening...',
      searchBankAccounts: 'Zoek bankrekeningen...',
      noBankAccountsFound: 'Geen bankrekeningen gevonden.',
      accountType: 'Type',
      balance: 'Saldo',

      mandate: 'Machtiging *',
      selectMandate: 'Selecteer machtiging...',
      searchMandates: 'Zoek machtigingen...',
      noMandatesFound: 'Geen machtigingen gevonden.',
      mandateReference: 'Ref',
      mandateStatus: 'Status',
      mandateSignedDate: 'Getekend',
      mandateExpiry: 'Vervaldatum',

      frequency: 'Frequentie *',
      firstPaymentDate: 'Eerste Betalingsdatum *',
      pickDate: 'Kies een datum',
      dayOfMonth: 'Dag van de Maand',
      dayOfWeek: 'Dag van de Week',

      // Frequency options
      frequencies: {
        weekly: 'Wekelijks',
        biweekly: 'Tweewekelijks',
        monthly: 'Maandelijks',
        quarterly: 'Kwartaal',
        annually: 'Jaarlijks',
      },

      // Days of week
      daysOfWeek: {
        monday: 'Maandag',
        tuesday: 'Dinsdag',
        wednesday: 'Woensdag',
        thursday: 'Donderdag',
        friday: 'Vrijdag',
        saturday: 'Zaterdag',
        sunday: 'Zondag',
      },

      notes: 'Notities',
      notesPlaceholder: 'Voeg eventuele aanvullende opmerkingen over deze automatische incasso toe...',
      notifyVendor: 'Leverancier Informeren',
      notifyVendorDesc: 'Stuur een e-mailmelding naar de leverancier wanneer de betaling wordt verwerkt',

      // Preview
      nextPaymentDates: 'Volgende Betalingsdata',
      previewDescription: 'Op basis van de geselecteerde frequentie zijn dit de volgende {count} betalingsdata:',
      totalPerPayment: 'per betaling',

      // Vendor info alert
      vendorInfoTitle: 'Bankgegevens Leverancier',
      vendorInfoAccount: 'Rekening: {accountNumber}',
      vendorInfoSort: 'Sorteercode: {sortCode}',

      // Summary labels
      referenceNumber: 'Referentie',
      totalAmount: 'Bedrag',
      frequencyLabel: 'Frequentie',
      vendor: 'Leverancier',
      bankAccount: 'Bankrekening',
      mandateRef: 'Machtiging',
      firstPayment: 'Eerste Betaling',
      notifying: 'Leverancier Informeren',
      yes: 'Ja',
      no: 'Nee',

      // Status badges
      statusActive: 'Actief',
      statusPending: 'In Behandeling',
      statusExpired: 'Verlopen',
      statusCancelled: 'Geannuleerd',

      // Actions and messages
      createDirectDebit: 'Automatische Incasso Aanmaken',
      creatingDirectDebit: 'Automatische Incasso Aanmaken...',
      cancel: 'Annuleren',

      // Validation messages
      selectVendorRequired: 'Selecteer een leverancier',
      selectBankAccountRequired: 'Selecteer een bankrekening',
      selectMandateRequired: 'Selecteer een machtiging',
      enterValidAmount: 'Voer een geldig bedrag in',
      selectFirstPaymentDate: 'Selecteer de eerste betalingsdatum',
      directDebitCreated: 'Automatische incasso {reference} succesvol aangemaakt',
      failedToCreate: 'Aanmaken automatische incasso mislukt',
      unexpectedError: 'Er is een onverwachte fout opgetreden',
    },

    paymentBatches: {
      title: 'Betalingsbatches',
      newPaymentBatch: 'Nieuwe Betalingsbatch',
      batchSummary: 'Batch Overzicht',

      // Sections
      batchInformation: 'Batch Informatie',
      bankAccountSelection: 'Bankrekening Selectie',
      addPayments: 'Betalingen Toevoegen aan Batch',
      batchPayments: 'Batch Betalingen',
      processingSchedule: 'Verwerking & Planning',

      // Form labels
      batchNumber: 'Batch Nummer',
      batchType: 'Batch Type',
      paymentDate: 'Betaaldatum *',
      selectDate: 'Selecteer datum',
      description: 'Beschrijving',
      descriptionPlaceholder: 'bijv., Maandelijkse leveranciersbetalingen - januari 2024',

      // Batch types
      batchTypes: {
        vendorPayments: 'Leveranciersbetalingen',
        employeePayroll: 'Werknemers Salarisadministratie',
        taxPayments: 'Belastingbetalingen',
        other: 'Overig',
      },

      // Bank account
      selectBankAccount: 'Selecteer Bankrekening *',
      searchBankAccounts: 'Zoek bankrekeningen...',
      noBankAccountsFound: 'Geen bankrekeningen gevonden.',
      availableBalance: 'Beschikbaar Saldo',

      // Vendor & payment selection
      selectVendor: 'Selecteer Leverancier',
      searchVendors: 'Zoek leveranciers...',
      noVendorsFound: 'Geen leveranciers gevonden.',
      outstandingBalance: 'Openstaand',
      paymentTerms: 'Voorwaarden',

      paymentAmount: 'Betalingsbedrag',
      amountPlaceholder: '0,00',
      paymentMethod: 'Betalingsmethode',
      selectPaymentMethod: 'Selecteer betalingsmethode',
      memo: 'Notitie (Optioneel)',
      memoPlaceholder: 'Betalingsreferentie of notities...',

      selectBills: 'Selecteer Facturen om te Betalen',
      noBillsAvailable: 'Geen openstaande facturen voor deze leverancier',
      billNumber: 'Factuur #',
      billDate: 'Datum',
      dueDate: 'Vervaldatum',
      billAmount: 'Bedrag',

      addToQueue: 'Toevoegen aan Wachtrij',
      addPayment: 'Betaling Toevoegen',

      // Payment methods
      paymentMethods: {
        ach: 'ACH Overboeking',
        wire: 'SWIFT Overboeking',
        check: 'Cheque',
        card: 'Kaart',
      },

      // Batch payments table
      paymentsInBatch: 'Betalingen in Batch ({count})',
      noPaymentsAdded: 'Nog geen betalingen toegevoegd',
      addPaymentsToStart: 'Voeg leveranciersbetalingen toe om uw batch te beginnen',
      selectAll: 'Alles Selecteren',
      deselectAll: 'Alles Deselecteren',

      vendorColumn: 'Leverancier',
      amountColumn: 'Bedrag',
      methodColumn: 'Methode',
      billsColumn: 'Facturen',
      memoColumn: 'Notitie',
      actionsColumn: 'Acties',

      billsCount: '{count} factuur/facturen',
      remove: 'Verwijderen',
      edit: 'Bewerken',

      // Processing
      processBatch: 'Batch Verwerken',
      processingDate: 'Verwerkingsdatum',
      scheduleForLater: 'Later Inplannen',
      processImmediately: 'Direct Verwerken',
      processImmediatelyDesc: 'Verwerk alle betalingen in deze batch nu direct',
      scheduleProcessing: 'Verwerking Inplannen',
      scheduleProcessingDesc: 'Plan batchverwerking voor een specifieke datum en tijd',

      // Summary
      totalPayments: 'Totaal Betalingen',
      totalAmount: 'Totaalbedrag',
      selectedPayments: 'Geselecteerde Betalingen',
      batchDate: 'Batch Datum',
      bankAccount: 'Bankrekening',
      batchStatus: 'Status',
      processingFees: 'Verwerkingskosten',
      netAmount: 'Nettobedrag',
      afterPayment: 'Na Betaling',

      // Status
      statusDraft: 'Concept',
      statusScheduled: 'Ingepland',
      statusProcessing: 'Verwerken',
      statusCompleted: 'Voltooid',

      // Actions
      createBatch: 'Batch Aanmaken',
      creatingBatch: 'Batch Aanmaken...',
      saveDraft: 'Concept Opslaan',
      cancel: 'Annuleren',

      // Validation messages
      selectVendorRequired: 'Selecteer een leverancier',
      enterValidAmount: 'Voer een geldig betalingsbedrag in',
      paymentUpdated: 'Betaling bijgewerkt',
      paymentAdded: 'Betaling toegevoegd aan batch',
      addAtLeastOnePayment: 'Voeg minimaal één betaling toe aan de batch',
      selectBankAccountRequired: 'Selecteer een bankrekening',
      insufficientFunds: 'Onvoldoende saldo op geselecteerde bankrekening',
      batchCreated: 'Betalingsbatch {batchNumber} succesvol aangemaakt',
      failedToCreate: 'Aanmaken betalingsbatch mislukt',
      unexpectedError: 'Er is een onverwachte fout opgetreden',

      // Warnings
      insufficientFundsWarning: 'Onvoldoende Saldo',
      insufficientFundsDesc: 'De geselecteerde bankrekening heeft niet voldoende saldo om alle betalingen in deze batch te verwerken.',
      currentBalance: 'Huidig saldo: {balance}',
      requiredAmount: 'Vereist bedrag: {amount}',
    },

    customers: {
      title: 'Klanten',
      newCustomer: 'Nieuwe Klant',
      createCustomer: 'Klant Aanmaken',
      creatingCustomer: 'Klant Aanmaken...',

      // Form sections
      basicInformation: 'Basisinformatie',
      contactInformation: 'Contactgegevens',
      billingAddress: 'Factuuradres',
      shippingAddress: 'Verzendadres',
      accountDetails: 'Accountgegevens',
      additionalInformation: 'Aanvullende Informatie',
      customerSummary: 'Klant Overzicht',

      // Basic Information
      customerCode: 'Klantcode',
      customerType: 'Klanttype',
      selectType: 'Selecteer type',
      companyName: 'Bedrijfsnaam',
      companyPlaceholder: 'ACME Corporation',
      firstName: 'Voornaam',
      firstNamePlaceholder: 'Jan',
      lastName: 'Achternaam',
      lastNamePlaceholder: 'Jansen',
      taxId: 'BTW-nummer',
      taxIdPlaceholder: 'NL000000000B01',
      industry: 'Branche',
      selectIndustry: 'Selecteer branche',

      // Contact Information
      email: 'E-mail',
      emailPlaceholder: 'jan@voorbeeld.nl',
      phone: 'Telefoon',
      phonePlaceholder: '+31 6 12345678',
      mobile: 'Mobiel',
      mobilePlaceholder: '+31 6 87654321',
      website: 'Website',
      websitePlaceholder: 'https://voorbeeld.nl',

      // Address fields
      streetAddress: 'Straat en Huisnummer',
      streetAddressPlaceholder: 'Hoofdstraat 123',
      addressLine2: 'Adresregel 2 (Optioneel)',
      addressLine2Placeholder: 'Appartement, Verdieping',
      city: 'Plaats',
      cityPlaceholder: 'Amsterdam',
      stateProvince: 'Provincie',
      selectState: 'Selecteer provincie',
      postalCode: 'Postcode',
      postalCodePlaceholder: '1012 AB',
      country: 'Land',
      selectCountry: 'Selecteer land',

      // Shipping Address
      sameAsBilling: 'Hetzelfde als Factuuradres',
      sameAsBillingDesc: 'Gebruik factuuradres voor verzending',

      // Account Details
      paymentTerms: 'Betalingsvoorwaarden',
      selectPaymentTerms: 'Selecteer betalingsvoorwaarden',
      creditLimit: 'Kredietlimiet',
      creditLimitPlaceholder: '10000,00',
      discountRate: 'Kortingspercentage (%)',
      discountPlaceholder: '5',
      currency: 'Valuta',
      selectCurrency: 'Selecteer valuta',
      preferredPaymentMethod: 'Voorkeur Betaalmethode',
      selectPaymentMethod: 'Selecteer betaalmethode',

      // Payment Terms Options
      paymentTermsOptions: {
        net15: 'Netto 15',
        net30: 'Netto 30',
        net45: 'Netto 45',
        net60: 'Netto 60',
        dueOnReceipt: 'Bij Ontvangst',
        cod: 'Onder Rembours',
        prepaid: 'Vooruitbetaald',
      },

      // Customer Types
      customerTypes: {
        individual: 'Particulier',
        business: 'Zakelijk',
        corporate: 'Corporate',
        government: 'Overheid',
        nonprofit: 'Non-Profit',
      },

      // Payment Method Options
      paymentMethodOptions: {
        cash: 'Contant',
        check: 'Cheque',
        creditCard: 'Creditcard',
        debitCard: 'Betaalkaart',
        ach: 'ACH Overschrijving',
        wire: 'Bankoverschrijving',
        paypal: 'PayPal',
      },

      // Currency Options
      currencyOptions: {
        usd: 'USD - Amerikaanse Dollar',
        eur: 'EUR - Euro',
        gbp: 'GBP - Britse Pond',
        cad: 'CAD - Canadese Dollar',
        mxn: 'MXN - Mexicaanse Peso',
        cny: 'CNY - Chinese Yuan',
        jpy: 'JPY - Japanse Yen',
        inr: 'INR - Indiase Roepie',
      },

      // Additional Settings
      notes: 'Notities',
      notesPlaceholder: 'Voer eventuele aanvullende notities over deze klant in...',
      isActive: 'Actieve Klant',
      isActiveDesc: 'Klant kan bestellingen plaatsen en aankopen doen',
      isVip: 'VIP Klant',
      isVipDesc: 'Markeer als VIP voor speciale behandeling',
      allowCredit: 'Kredietaankopen Toestaan',
      allowCreditDesc: 'Sta deze klant toe om op krediet te kopen',

      // Summary
      customerInfo: 'Klantinformatie',
      customerName: 'Naam',
      customerEmail: 'E-mail',
      customerPhone: 'Telefoon',
      customerWebsite: 'Website',
      billingLocation: 'Factuurlocatie',
      shippingLocation: 'Verzendlocatie',
      creditLimitLabel: 'Kredietlimiet',
      discountRateLabel: 'Kortingspercentage',
      status: 'Status',
      vipStatus: 'VIP Status',
      active: 'Actief',
      inactive: 'Inactief',
      vip: 'VIP Klant',
      standard: 'Standaard',

      // Validation messages
      provideNameOrCompany: 'Geef een bedrijfsnaam of voor- en achternaam op',
      provideEmailOrPhone: 'Geef een e-mailadres of telefoonnummer op',
      customerCreated: 'Klant {code} succesvol aangemaakt',
      failedToCreate: 'Aanmaken klant mislukt',
      unexpectedError: 'Er is een onverwachte fout opgetreden',

      // Actions
      cancel: 'Annuleren',

      // List component
      loadingCustomers: 'Klanten laden...',
      searchCustomers: 'Zoek klanten...',
      customersCount: '{filtered} van {total} klanten',
      noCustomersFound: 'Geen klanten gevonden.',
      noCustomersSearch: 'Geen klanten gevonden die overeenkomen met uw zoekopdracht.',

      // Table headers
      table: {
        customer: 'Klant',
        contact: 'Contact',
        location: 'Locatie',
        activity: 'Activiteit',
        invoices: 'Facturen',
        revenue: 'Omzet',
        outstanding: 'Openstaand',
        noLocation: 'Geen locatie',
        lastActivity: 'Laatste:',
        orders: 'orders',
      },

      // Activity Status
      activityStatus: {
        active: 'Actief',
        inactive: 'Inactief',
        dormant: 'Inactief',
      },

      // Actions Menu
      actionsMenu: {
        openMenu: 'Menu openen',
        actions: 'Acties',
        viewDetails: 'Details Bekijken',
        editCustomer: 'Klant Bewerken',
        deleteCustomer: 'Verwijderen',
        confirmDelete: 'Weet u zeker dat u {name} wilt verwijderen? Deze actie kan niet ongedaan worden gemaakt.',
      },

      // Messages
      messages: {
        customerDeleted: 'Klant succesvol verwijderd',
        deleteFailed: 'Verwijderen klant mislukt',
      },

      // Stats component
      stats: {
        totalCustomers: 'Totaal Klanten',
        totalCustomersDesc: 'Alle klanten',
        newThisMonth: 'Nieuw Deze Maand',
        newThisMonthDesc: 'Deze maand toegevoegd',
        totalRevenue: 'Totale Omzet',
        totalRevenueDesc: 'Levenslange waarde',
        outstanding: 'Openstaand',
        outstandingDesc: 'Onbetaalde facturen',
      },
    },

    // Products
    products: {
      title: 'Producten',
      newProduct: 'Nieuw Product',
      createProduct: 'Product Aanmaken',
      creatingProduct: 'Product Aanmaken...',
      productSummary: 'Product Overzicht',

      // Sections
      productInformation: 'Productinformatie',
      categoryOrganization: 'Categorie & Organisatie',
      pricingInformation: 'Prijsinformatie',
      inventoryManagement: 'Voorraadbeheer',
      physicalAttributes: 'Fysieke Eigenschappen',
      additionalNotes: 'Aanvullende Notities',

      // Form labels
      sku: 'SKU',
      skuCode: 'SKU-code',
      skuPlaceholder: 'Bijv. PROD-001',
      skuHelpText: 'Unieke productcode voor identificatie',
      barcode: 'Barcode',
      enterBarcode: 'Voer barcode in',
      barcodePlaceholder: 'Bijv. 1234567890123',
      barcodeHelpText: 'EAN of UPC barcode',
      productName: 'Productnaam',
      enterProductName: 'Voer productnaam in',
      productNamePlaceholder: 'Bijv. Widget Pro 2000',
      description: 'Beschrijving',
      productDescription: 'Productomschrijving',
      descriptionPlaceholder: 'Geef een gedetailleerde beschrijving van het product...',

      // Category & Organization
      category: 'Categorie',
      productCategory: 'Productcategorie',
      categoryPlaceholder: 'Zoek categorie...',
      searchCategories: 'Zoek categorieën...',
      noCategoriesFound: 'Geen categorieën gevonden.',
      noCategoryFound: 'Geen categorie gevonden',
      selectCategory: 'Selecteer categorie...',
      vendor: 'Leverancier',
      vendorPlaceholder: 'Zoek leverancier...',
      searchVendors: 'Zoek leveranciers...',
      noVendorsFound: 'Geen leveranciers gevonden.',
      noVendorFound: 'Geen leverancier gevonden',
      selectVendor: 'Selecteer leverancier...',
      warehouse: 'Magazijn',
      warehousePlaceholder: 'Zoek magazijn...',
      searchWarehouses: 'Zoek magazijnen...',
      noWarehousesFound: 'Geen magazijnen gevonden.',
      noWarehouseFound: 'Geen magazijn gevonden',
      selectWarehouse: 'Selecteer magazijn...',

      // Pricing Information
      unitPrice: 'Eenheidsprijs',
      unitPricePlaceholder: '0.00',
      unitPriceHelpText: 'Verkoopprijs per eenheid',
      costPrice: 'Kostprijs',
      costPricePlaceholder: '0.00',
      costPriceHelpText: 'Kostprijs per eenheid',
      taxRate: 'BTW-tarief',
      taxRatePlaceholder: '0',
      taxRateHelpText: 'BTW-percentage',
      markup: 'Opslag',
      markupPercentage: 'Opslag %',
      markupValue: '{value}%',
      profitMargin: 'Winstmarge',
      profitMarginPercentage: 'Marge %',
      profitMarginValue: '{value}%',

      // Inventory Management
      trackInventory: 'Voorraad Bijhouden',
      trackInventoryDesc: 'Schakel voorraadbijhouding in voor dit product',
      currentStock: 'Huidige Voorraad',
      currentStockPlaceholder: '0',
      currentStockHelpText: 'Huidige voorraadniveau',
      minStock: 'Minimum Voorraadniveau',
      minStockPlaceholder: '0',
      minStockHelpText: 'Minimaal aan te houden voorraad',
      maxStock: 'Maximum Voorraadniveau',
      maxStockPlaceholder: '0',
      reorderPoint: 'Bestelpunt',
      reorderPointPlaceholder: '0',
      reorderPointHelpText: 'Wanneer te herbestellen',
      reorderQuantity: 'Bestelhoeveelheid',
      reorderQuantityPlaceholder: '0',

      // Physical Attributes
      weight: 'Gewicht',
      weightPlaceholder: '0.00',
      weightUnit: 'Gewichtseenheid',
      kg: 'kg',
      lbs: 'lbs',
      length: 'Lengte',
      lengthPlaceholder: '0.00',
      width: 'Breedte',
      widthPlaceholder: '0.00',
      height: 'Hoogte',
      heightPlaceholder: '0.00',
      dimensionUnit: 'Afmetingseenheid',
      dimensionsUnit: 'Eenheid',
      cm: 'cm',
      inches: 'inches',

      // Additional Notes
      notes: 'Notities',
      notesPlaceholder: 'Voeg eventuele aanvullende notities of opmerkingen toe...',

      // Settings
      isActive: 'Actief Product',
      isActiveDesc: 'Product is beschikbaar voor verkoop',
      isFeatured: 'Uitgelicht Product',
      isFeaturedDesc: 'Toon product als uitgelicht',
      allowBackorder: 'Nabestelling Toestaan',
      allowBackorderDesc: 'Bestellingen toestaan wanneer niet op voorraad',

      // Summary
      code: 'Code',
      name: 'Naam',
      categoryLabel: 'Categorie',
      vendorLabel: 'Leverancier',
      warehouseLabel: 'Magazijn',
      price: 'Prijs',
      cost: 'Kosten',
      stock: 'Voorraad',
      units: 'eenheden',
      dimensions: 'Afmetingen',
      dimensionsValue: '{length} × {width} × {height} {unit}',
      weightLabel: 'Gewicht',
      weightValue: '{weight} {unit}',
      status: 'Status',
      active: 'Actief',
      inactive: 'Inactief',
      featured: 'Uitgelicht',
      inStock: 'Op Voorraad',
      lowStock: 'Lage Voorraad',
      outOfStock: 'Niet op Voorraad',
      notTracked: 'Niet Bijgehouden',

      // Validation messages
      fillRequired: 'Vul alle verplichte velden in',
      productNameRequired: 'Voer een productnaam in',
      enterValidPrice: 'Voer een geldige eenheidsprijs in',
      enterValidCost: 'Voer een geldige kostprijs in',
      skuExists: 'SKU bestaat al',
      productCreated: 'Product {sku} succesvol aangemaakt',
      failedToCreate: 'Aanmaken product mislukt',
      unexpectedError: 'Er is een onverwachte fout opgetreden',

      // Actions
      cancel: 'Annuleren',

      // List component
      loadingProducts: 'Producten laden...',
      searchProducts: 'Zoek producten...',
      productsCount: '{count} producten',
      noProductsFound: 'Geen producten gevonden.',
      noProductsFilters: 'Geen producten gevonden die overeenkomen met uw filters.',

      // Filters
      filters: {
        category: 'Categorie',
        allCategories: 'Alle Categorieën',
        uncategorized: 'Ongecategoriseerd',
        stock: 'Voorraad',
        allStock: 'Alle Voorraad',
      },

      // Table headers
      table: {
        product: 'Product',
        category: 'Categorie',
        stock: 'Voorraad',
        price: 'Prijs',
        sales: 'Verkoop',
        created: 'Aangemaakt',
        skuLabel: 'SKU:',
        sold: 'verkocht',
        invoiced: 'gefactureerd',
      },

      // Actions Menu
      actionsMenu: {
        openMenu: 'Menu openen',
        actions: 'Acties',
        viewDetails: 'Details Bekijken',
        editProduct: 'Product Bewerken',
        deactivate: 'Deactiveren',
        confirmDeactivate: 'Weet u zeker dat u {name} wilt deactiveren? Het wordt verborgen uit de productlijst, maar de gegevens blijven behouden.',
      },

      // Messages
      messages: {
        productDeactivated: 'Product succesvol gedeactiveerd',
        deactivateFailed: 'Deactiveren product mislukt',
      },

      // Stats component
      stats: {
        totalProducts: 'Totaal Producten',
        totalProductsDesc: 'Alle producten',
        active: 'Actief',
        activeDesc: 'Beschikbare producten',
        lowStock: 'Lage Voorraad',
        lowStockDesc: 'Voorraad onder 10',
        inventoryValue: 'Voorraadwaarde',
        inventoryValueDesc: 'Totale productwaarde',
      },
    },

    // Integrations
    integrations: {
      title: 'Integraties',
      dashboard: 'Integratie Dashboard',
      quickBooksIntegration: 'QuickBooks Integratie Dashboard',
      exactOnlineIntegration: 'Exact Online Integratie Dashboard',

      status: {
        connected: 'Verbonden',
        disconnected: 'Niet verbonden',
        completed: 'Voltooid',
        failed: 'Mislukt',
        inProgress: 'Bezig',
        unknown: 'Onbekend',
      },

      buttons: {
        settings: 'Instellingen',
        fullSync: 'Volledige Synchronisatie',
        customers: 'Klanten',
        invoices: 'Facturen',
        payments: 'Betalingen',
        chartOfAccounts: 'Rekeningschema',
      },

      metrics: {
        totalSyncs: 'Totaal Synchronisaties',
        successRate: 'Succespercentage',
        itemsSynced: 'Items Gesynchroniseerd',
        failedSyncs: 'Mislukte Synchronisaties',
        lastSync: 'Laatste synchronisatie',
        acrossAllOperations: 'Over alle synchronisatie-operaties',
        reviewErrorLogs: 'Bekijk foutmeldingen hieronder',
      },

      quickSyncActions: {
        title: 'Snelle Synchronisatie Acties',
        description: 'Synchroniseer specifieke datatypes afzonderlijk',
      },

      syncHistory: {
        title: 'Synchronisatiegeschiedenis',
        description: 'Recente synchronisatie-activiteiten en hun status',
        noHistory: 'Geen synchronisatiegeschiedenis beschikbaar',

        tabs: {
          all: 'Alle',
          successful: 'Succesvol',
          failed: 'Mislukt',
        },

        table: {
          status: 'Status',
          type: 'Type',
          started: 'Gestart',
          duration: 'Duur',
          items: 'Items',
          error: 'Fout',
        },
      },

      messages: {
        syncCompleted: '{type} synchronisatie succesvol voltooid',
        syncFailed: 'Synchronisatie mislukt',
      },
    },

    // Banking pages
    bankingPages: {
      pageTitle: 'Bankrekeningen',
      addBankAccount: 'Bankrekening Toevoegen',
      comingSoon: 'Binnenkort beschikbaar',
      noBankAccountsTitle: 'Geen bankrekeningen geconfigureerd',
      noBankAccountsDesc: 'Voeg een bankrekening toe om afschriften te importeren en betalingen automatisch af te stemmen met facturen en inkoopfacturen.',
      addFirstAccount: 'Voeg uw eerste bankrekening toe',
      columns: {
        name: 'Naam',
        iban: 'IBAN',
        bank: 'Bank',
        currency: 'Valuta',
        balance: 'Saldo',
      },
      badges: {
        default: 'Standaard',
        inactive: 'Inactief',
        autoReconcileOn: 'Automatisch afstemmen aan',
      },

      // Account detail page
      backToAccounts: 'Bankrekeningen',
      currentBalance: 'Huidig saldo',
      unreconciled: 'Niet afgestemd',
      ofTransactions: 'van {total} transacties',
      lastImport: 'Laatste import',
      edit: 'Bewerken',
      deleteBankAccount: 'Bankrekening verwijderen',
      autoReconcile: 'Automatisch afstemmen',
      importStatement: 'Afschrift importeren',
      noTransactionsYet: 'Nog geen transacties. Importeer een bankafschrift om te beginnen.',
      allTransactions: 'Alle transacties',
      unreconciledFilter: 'Niet afgestemd',
      reconciledFilter: 'Afgestemd',
      excludedFilter: 'Uitgesloten',
      deleteConfirmTitle: 'Deze bankrekening verwijderen?',
      deleteConfirmDesc: 'Dit verwijdert de bankrekening tijdelijk. Geïmporteerde transacties blijven bewaard maar zijn niet meer zichtbaar in de interface. Deze actie kan worden teruggedraaid in de database indien nodig.',
      delete: 'Verwijderen',
      cancel: 'Annuleren',
      bankAccountNotFound: 'Bankrekening niet gevonden.',

      // Import page
      importTitle: 'Banktransacties Importeren',
      step1Title: 'Stap 1: Selecteer Bankrekening',
      step2Title: 'Stap 2: Upload Bankbestand',
      bankAccount: 'Bankrekening',
      selectBankAccount: 'Selecteer bankrekening',
      next: 'Volgende',
      back: 'Terug',
      uploadDescription: 'Upload een MT940, CAMT.053 (XML) of CSV bankafschriftbestand. Het formaat wordt automatisch gedetecteerd.',
      clickToSelect: 'Klik om een bestand te selecteren of sleep hier naartoe',
      importing: 'Importeren...',
      import: 'Importeren',
      importFailed: 'Import mislukt: {error}',
      importCompleteTitle: 'Import Voltooid',
      formatDetected: 'Formaat gedetecteerd:',
      totalParsed: 'Totaal verwerkt:',
      imported: 'Geïmporteerd:',
      duplicatesSkipped: 'Duplicaten overgeslagen:',
      autoReconciled: 'Automatisch afgestemd:',
      parseErrors: 'Verwerkingsfouten:',
      importAnother: 'Nog een importeren',
      done: 'Klaar',

      // Reconciliation page
      reconciliationTitle: 'Bankafstemmingen',
      autoReconcileAll: 'Alles Automatisch Afstemmen',
      running: 'Bezig...',
      autoReconciledCount: '{count} transacties automatisch afgestemd',
      unreconciledTransactions: 'Niet-afgestemde Transacties ({count})',
      allReconciled: 'Alle transacties afgestemd!',
      matchSuggestions: 'Overeenkomstsuggesties',
      selectTransaction: 'Selecteer een Transactie',
      clickToSeeSuggestions: 'Klik op een transactie links om overeenkomstsuggesties te zien.',
      noMatchesFound: 'Geen automatische overeenkomsten gevonden.',
      excludeTransaction: 'Transactie Uitsluiten',
      reconcile: 'Afstemmen',
      amount: 'Bedrag: {amount}',
      confidence: 'Betrouwbaarheid: {percent}%',

      // Rules page
      newRule: 'Nieuwe Regel',
      noRulesTitle: 'Nog geen afstemmingsregels. Maak er een aan om terugkerende transacties zoals huur, abonnementen of bankkosten automatisch te categoriseren.',
      createFirstRule: 'Maak uw eerste regel aan',
      deleteRuleTitle: 'Deze regel verwijderen?',
      deleteRuleDesc: 'Bestaande afgestemde transacties worden niet beïnvloed. Nieuwe imports passen deze regel niet meer toe.',
      columns_rules: {
        name: 'Naam',
        priority: 'Prioriteit',
        conditions: 'Voorwaarden',
        actions: 'Acties',
        matches: 'Overeenkomsten',
        lastMatched: 'Laatste overeenkomst',
        status: 'Status',
      },
      conditionsSummary: '{count} voorwaarde — {mode} moet overeenkomen',
      conditionsSummaryPlural: '{count} voorwaarden — {mode} moeten overeenkomen',
      ruleStatusActive: 'Actief',
      ruleStatusInactive: 'Inactief',
      ruleActionEdit: 'Bewerken',
      ruleActionDelete: 'Verwijderen',
      ruleNever: 'Nooit',

      // Transactions page
      transactionsTitle: 'Banktransacties',
      transactionsSubtitle: 'Geïmporteerde activiteit over al uw bankrekeningen.',
      importStatementButton: 'Afschrift importeren',
      accountLabel: 'Rekening',
      statusLabel: 'Status',
      fromLabel: 'Van',
      toLabel: 'Tot',
      searchLabel: 'Zoeken',
      searchPlaceholder: 'Omschrijving, tegenpartij, referentie…',
      allAccounts: 'Alle rekeningen',
      allStatuses: 'Alle statussen',
      noTransactionsMatch: 'Geen transacties komen overeen met de geselecteerde filters.',
      transactionCount: '{count} transactie',
      transactionCountPlural: '{count} transacties',
      previous: 'Vorige',
      next_page: 'Volgende',
      pageOf: 'Pagina {page} van {total}',
    },

    // Bill form (shared bill-form component)
    billForm: {
      billDetails: 'Inkoopfactuurgegevens',
      supplier: 'Leverancier',
      selectSupplier: 'Selecteer leverancier',
      externalReference: 'Externe Referentie',
      supplierInvoiceNumber: 'Factuurnummer leverancier',
      issueDate: 'Factuurdatum',
      dueDate: 'Vervaldatum',
      lineItems: 'Regelitems',
      addLine: 'Regel Toevoegen',
      description: 'Omschrijving',
      qty: 'Aantal',
      unitPrice: 'Prijs',
      discountPercent: 'Korting %',
      taxRate: 'BTW-tarief',
      account: 'Rekening',
      lineTotal: 'Regeltotaal',
      none: 'Geen',
      subtotal: 'Subtotaal',
      tax: 'BTW',
      total: 'Totaal',
      notes: 'Notities',
      notesVisibleToSupplier: 'Notities (zichtbaar voor leverancier)',
      internalNotes: 'Interne Notities',
      saving: 'Opslaan...',
      createBill: 'Inkoopfactuur Aanmaken',
      updateBill: 'Inkoopfactuur Bijwerken',
      billNotFound: 'Inkoopfactuur niet gevonden.',
      backToBills: 'Terug naar inkoopfacturen',
      newBill: 'Nieuwe Inkoopfactuur',
      editBill: 'Inkoopfactuur Bewerken {number}',
      prefilledFromOcr: 'Vooringevuld via OCR',
      ocrConfidence: '({percent}% betrouwbaarheid)',
      verifyValues: 'Controleer de waarden voor het opslaan.',
    },

    // Bill detail page
    billDetail: {
      billNotFound: 'Inkoopfactuur niet gevonden.',
      backToBills: 'Terug naar inkoopfacturen',
      edit: 'Bewerken',
      approve: 'Goedkeuren',
      reject: 'Afwijzen',
      supplier: 'Leverancier',
      dates: 'Datums',
      issued: 'Uitgifte:',
      due: 'Vervaldatum:',
      reference: 'Referentie',
      lineItems: 'Regelitems',
      description: 'Omschrijving',
      qty: 'Aantal',
      unitPrice: 'Prijs',
      discountPercent: 'Korting %',
      tax: 'BTW',
      lineTotal: 'Regeltotaal',
      noLineItems: 'Geen regelitems',
      subtotal: 'Subtotaal',
      total: 'Totaal',
      paid: 'Betaald',
      balanceDue: 'Te Betalen Saldo',
      notes: 'Notities',
      internalNotes: 'Interne Notities',
      rejectBillTitle: 'Inkoopfactuur Afwijzen',
      rejectBillDescription: 'Geef een reden voor het afwijzen van deze inkoopfactuur.',
      rejectReason: 'Reden',
      rejectReasonPlaceholder: 'Voer afwijzingsreden in...',
      cancel: 'Annuleren',
      rejecting: 'Afwijzen...',
      rejectConfirm: 'Afwijzen',
    },

    // Contact/Customer pages
    contacts: {
      newContact: 'Nieuw Contact',
      editContact: 'Contact Bewerken',
      contactNotFound: 'Contact niet gevonden.',
      general: 'Algemeen',
      contactDetails: 'Contactgegevens',
      taxAndRegistration: 'Belasting & Registratie',
      bankingSection: 'Bankieren',
      payment: 'Betaling',
      notes: 'Notities',
      role: 'Rol',
      name: 'Naam',
      firstName: 'Voornaam',
      lastName: 'Achternaam',
      companyName: 'Bedrijfsnaam',
      email: 'E-mail',
      phone: 'Telefoon',
      btwNumber: 'BTW-nummer',
      kvkNumber: 'KvK-nummer',
      iban: 'IBAN',
      bic: 'BIC',
      paymentTermsDays: 'Betalingstermijn (dagen)',
      roles: {
        customer: 'Klant',
        supplier: 'Leverancier',
        both: 'Klant + leverancier',
      },
      creating: 'Aanmaken...',
      saving: 'Opslaan...',
      createContact: 'Contact Aanmaken',
      saveChanges: 'Wijzigingen Opslaan',
      cancel: 'Annuleren',
      outstandingBalance: 'Openstaand Saldo',
      financial: 'Financieel',
      company: 'Bedrijf',
    },

    // Invoice detail page
    invoiceDetail: {
      invoiceNotFound: 'Factuur niet gevonden',
      downloadPdf: 'PDF Downloaden',
      generatingPdf: 'Genereren...',
      edit: 'Bewerken',
      send: 'Versturen',
      finalizing: 'Afronden...',
      finalize: 'Afronden',
      recordPayment: 'Betaling Registreren',
      contact: 'Contactpersoon',
      dates: 'Datums',
      issueDate: 'Factuurdatum',
      dueDate: 'Vervaldatum',
      reference: 'Referentie',
      lineItems: 'Regelitems',
      description: 'Omschrijving',
      qty: 'Aantal',
      unitPrice: 'Prijs',
      discount: 'Korting',
      tax: 'BTW',
      total: 'Totaal',
      noLineItems: 'Geen regelitems',
      subtotal: 'Subtotaal',
      amountPaid: 'Betaald Bedrag',
      balanceDue: 'Te Betalen Saldo',
      failedToPdf: 'PDF genereren mislukt',
    },

    // Invoice dialog (create invoice)
    invoiceDialog: {
      newInvoice: 'Nieuwe Factuur',
      createForCustomer: 'Maak een nieuwe factuur aan voor een klant.',
      customer: 'Klant',
      selectCustomer: 'Selecteer een klant',
      searchCustomers: 'Klanten zoeken...',
      noCustomersFound: 'Geen klanten gevonden.',
      issueDate: 'Factuurdatum',
      dueDate: 'Vervaldatum',
      reference: 'Referentie',
      referencePlaceholder: 'PO-nummer, projectcode, etc.',
      lineItems: 'Regelitems',
      addItem: 'Item Toevoegen',
      itemNumber: 'Item {number}',
      descriptionPlaceholder: 'Omschrijving',
      qtyPlaceholder: 'Aantal',
      unitPricePlaceholder: 'Eenheidsprijs',
      taxRatePlaceholder: 'BTW-tarief',
      discountPlaceholder: 'Korting %',
      noTax: 'Geen BTW',
      notes: 'Notities',
      notesPlaceholder: 'Betalingsinstructies, bedankberichtje, etc.',
      subtotal: 'Subtotaal',
      tax: 'BTW',
      total: 'Totaal',
      cancel: 'Annuleren',
      creating: 'Aanmaken...',
      createInvoice: 'Factuur Aanmaken',
      invoiceCreated: 'Factuur succesvol aangemaakt',
      failedToCreate: 'Factuur aanmaken mislukt',
    },

    // Record payment dialog
    recordPayment: {
      title: 'Betaling Registreren',
      amount: 'Bedrag',
      date: 'Datum',
      paymentMethod: 'Betaalmethode',
      selectMethod: 'Selecteer methode',
      reference: 'Referentie (optioneel)',
      cancel: 'Annuleren',
      recording: 'Registreren...',
      recordPayment: 'Betaling Registreren',
      methods: {
        bankTransfer: 'Bankoverschrijving',
        cash: 'Contant',
        card: 'Kaart',
        ideal: 'iDEAL',
      },
    },

    // Send invoice dialog
    sendInvoice: {
      title: 'Factuur Versturen',
      sendToEmail: 'Factuur versturen naar {email}?',
      noEmailFound: 'Geen e-mailadres gevonden voor dit contact. Weet u zeker dat u deze factuur als verzonden wilt markeren?',
      cancel: 'Annuleren',
      sending: 'Versturen...',
      send: 'Versturen',
    },

    // Invoice form (edit)
    invoiceForm: {
      editInvoice: 'Factuur Bewerken',
      newInvoice: 'Nieuwe Factuur',
      invoiceNotFound: 'Factuur niet gevonden.',
      basicInformation: 'Basisgegevens',
      lineItems: 'Regelitems',
      notes: 'Opmerkingen',
      customer: 'Klant',
      selectCustomer: 'Selecteer een klant',
      issueDate: 'Factuurdatum',
      dueDate: 'Vervaldatum',
      reference: 'Referentie',
      referencePlaceholder: 'PO-nummer, projectcode, etc.',
      itemNumber: 'Regel {number}',
      description: 'Omschrijving',
      itemDescriptionPlaceholder: 'Regelomschrijving',
      quantity: 'Aantal',
      unitPrice: 'Stukprijs',
      taxRate: 'BTW-tarief',
      noTax: 'Geen',
      discountPercent: 'Korting %',
      lineTotal: 'Regeltotaal:',
      addItem: 'Regel toevoegen',
      notesLabel: 'Opmerkingen (zichtbaar op factuur)',
      notesPlaceholder: 'Betalingsinstructies, bedankbericht, etc.',
      internalNotes: 'Interne opmerkingen',
      internalNotesPlaceholder: 'Interne opmerkingen (niet zichtbaar voor de klant)',
      invoiceSummary: 'Factuuroverzicht',
      items: '{count} regelitem',
      itemsPlural: '{count} regelitems',
      subtotal: 'Subtotaal',
      tax: 'BTW',
      total: 'Totaal',
      createInvoice: 'Factuur aanmaken',
      updateInvoice: 'Factuur bijwerken',
      backToInvoices: 'Terug naar facturen',
      invoiceUpdated: 'Factuur succesvol bijgewerkt',
      invoiceCreated: 'Factuur succesvol aangemaakt',
      failedToSave: 'Factuur opslaan mislukt',
    },

    // Invoices list page
    invoicesPage: {
      searchPlaceholder: 'Facturen zoeken...',
      newInvoice: 'Nieuwe Factuur',
      groupOverdue: 'Achterstallig',
      groupSent: 'Verzonden',
      groupDraft: 'Concept',
      groupPaid: 'Betaald',
      groupOther: 'Overig',
      colNumber: 'Nummer',
      colContact: 'Contactpersoon',
      colDate: 'Datum',
      colDueDate: 'Vervaldatum',
      colTotal: 'Totaal',
      colStatus: 'Status',
      noInvoices: 'Geen facturen gevonden',
    },

    // Journal entry pages
    journalEntry: {
      newEntry: 'Nieuwe Journaalpost',
      entryDetails: 'Postgegevens',
      journalLines: 'Journaalregels',
      date: 'Datum',
      reference: 'Referentie',
      referencePlaceholder: 'Optionele referentie',
      description: 'Omschrijving',
      descriptionPlaceholder: 'Postomschrijving',
      account: 'Rekening',
      selectAccount: 'Selecteer rekening',
      linePlaceholder: 'Regelomschrijving',
      debit: 'Debet',
      credit: 'Credit',
      totals: 'Totalen',
      addLine: 'Regel Toevoegen',
      notBalanced: 'Post is niet in balans. Verschil: {amount}',
      creating: 'Aanmaken...',
      createEntry: 'Post Aanmaken',
      cancel: 'Annuleren',
      notFound: 'Journaalpost niet gevonden.',
      postEntry: 'Post Boeken',
      posting: 'Boeken...',
      descriptionLabel: 'Omschrijving',
      sourceLabel: 'Bron',
      totalsLabel: 'Totalen',
      debitLabel: 'Debet:',
      creditLabel: 'Credit:',
      autoGenerated: 'Automatisch gegenereerd',
      noLines: 'Geen regels',
    },

    // Journal entries list page
    journalPage: {
      newEntry: 'Nieuwe Post',
      ungrouped: 'Geen datum',
      colDate: 'Datum',
      colReference: 'Referentie',
      colDescription: 'Omschrijving',
      colDebit: 'Debet',
      colCredit: 'Credit',
      noEntries: 'Geen journaalposten gevonden',
    },

    // Reports pages
    reports: {
      title: 'Rapporten',
      profitLoss: 'Winst & Verlies',
      profitLossDesc: 'Omzet, kosten en nettowinst voor een periode',
      balanceSheet: 'Balans',
      balanceSheetDesc: 'Activa, passiva en eigen vermogen op een bepaald moment',
      trialBalance: 'Proefbalans',
      trialBalanceDesc: 'Alle rekeningsaldi ter verificatie',
      agedReceivables: 'Ouderdomsanalyse Debiteuren',
      agedReceivablesDesc: 'Openstaande klantfacturen per leeftijd',
      agedPayables: 'Ouderdomsanalyse Crediteuren',
      agedPayablesDesc: 'Openstaande leveranciersfacturen per leeftijd',
      cashFlow: 'Kasstroomoverzicht',
      cashFlowDesc: 'Maandelijkse inkomsten, uitgaven en nettokasstromen',
      generalLedger: 'Grootboek',
      generalLedgerDesc: 'Alle transacties voor een specifieke rekening',
      // Shared report UI
      from: 'Van',
      to: 'Tot',
      asOf: 'Per',
      generate: 'Genereren',
      loading: 'Laden...',
      noData: 'Geen gegevens beschikbaar.',
      account: 'Rekening',
      amount: 'Bedrag',
      total: 'Totaal',
      // Profit & Loss
      revenue: 'Omzet',
      expenses: 'Kosten',
      totalRevenue: 'Totale Omzet',
      totalExpenses: 'Totale Kosten',
      netProfitLoss: 'Nettowinst / (Verlies)',
      // Balance Sheet
      totalPrefix: 'Totaal',
      assets: 'Activa',
      liabilities: 'Passiva',
      equity: 'Eigen Vermogen',
      // Trial Balance
      code: 'Code',
      debit: 'Debet',
      credit: 'Credit',
      totals: 'Totalen',
      // Aged reports
      bucketCurrent: 'Huidig',
      bucket1_30: '1-30 dagen',
      bucket31_60: '31-60 dagen',
      bucket61_90: '61-90 dagen',
      bucketOver90: '90+ dagen',
      colInvoice: 'Factuur',
      colBill: 'Inkoopfactuur',
      colContact: 'Contactpersoon',
      colSupplier: 'Leverancier',
      colDueDate: 'Vervaldatum',
      colDaysOverdue: 'Dagen Achterstallig',
      colBalanceDue: 'Openstaand Saldo',
      noOutstandingReceivables: 'Geen openstaande debiteuren',
      noOutstandingPayables: 'Geen openstaande crediteuren',
      // Cash Flow
      totalInflows: 'Totale Ontvangsten',
      totalOutflows: 'Totale Uitgaven',
      netCashFlow: 'Netto Kasstroom',
      monthlyBreakdown: 'Maandelijkse Uitsplitsing',
      colMonth: 'Maand',
      colInflows: 'Ontvangsten',
      colOutflows: 'Uitgaven',
      colNet: 'Netto',
      colRunningBalance: 'Lopend Saldo',
      // General Ledger
      selectAccount: 'Selecteer een rekening',
      transactions: 'Transacties',
      colDate: 'Datum',
      colEntryNumber: 'Boekings #',
      colDescription: 'Omschrijving',
      colBalance: 'Saldo',
      noTransactionsInPeriod: 'Geen transacties gevonden voor deze periode.',
      summary: 'Samenvatting',
      openingBalance: 'Beginsaldo',
      totalDebits: 'Totaal Debet',
      totalCredits: 'Totaal Credit',
      closingBalance: 'Eindsaldo',
      accountType: 'Type:',
    },

    // Settings page
    settings: {
      title: 'Instellingen',
      companyDetails: 'Bedrijfsgegevens',
      companyName: 'Bedrijfsnaam',
      companyNamePlaceholder: 'Bedrijfsnaam',
      vatNumber: 'BTW-nummer',
      vatNumberPlaceholder: 'BTW-nummer',
      chamberOfCommerce: 'Kamer van Koophandel',
      cocPlaceholder: 'KvK-nummer',
      iban: 'IBAN',
      ibanPlaceholder: 'IBAN',
      saveCompanyDetails: 'Bedrijfsgegevens Opslaan',
      numbering: 'Nummering',
      invoicePrefix: 'Factuurprefix',
      nextInvoiceNumber: 'Volgend Factuurnummer',
      saveNumbering: 'Nummering Opslaan',
      emailInbox: 'E-mailinbox',
      activeInbox: 'Actieve inbox:',
      autoScanEnabled: '(automatisch scannen ingeschakeld)',
      noInboxRegistered: 'Registreer een e-mailadres om facturen en documenten direct in de boekhoudingsinbox te ontvangen.',
      inboxEmailPlaceholder: 'boekhouding@bedrijf.weldsuite.org',
      registering: 'Registreren...',
      registerInbox: 'Inbox Registreren',
      inboxRegistered: 'Inbox succesvol geregistreerd.',
      seedData: 'Voorbeeldgegevens',
      seedDataDesc: 'Laad het standaard Nederlandse rekeningschema (RGS-gebaseerd) om snel van start te gaan.',
      seeding: 'Laden...',
      seedDutchAccounts: 'Nederlands Rekeningschema Laden',
      xafTitle: 'Auditfile (XAF 4.0)',
      xafDesc: 'Exporteer de XAF 4.0-auditfile voor een boekjaar — het formaat dat de Belastingdienst bij een boekenonderzoek vereist (verplicht sinds 1 januari 2026). Ook handig voor overdracht aan je accountant.',
      xafDownload: 'Auditfile downloaden',
      xafDownloading: 'Genereren…',
      seedWorkflowTemplates: 'Workflowsjablonen Laden',
      workflowsSeeded: 'Workflowsjablonen geladen: {count} sjablonen aangemaakt.',
    },

    // VAT pages
    vat: {
      title: 'BTW-aangifte',
      newReturn: 'Nieuwe BTW-aangifte',
      period: 'Periode',
      type: 'Type',
      status: 'Status',
      calculateReturn: 'BTW-aangifte Berekenen',
      periodType: 'Aangifteperiode',
      periodStart: 'Periode Begin',
      periodEnd: 'Periode Einde',
      periodLabel: 'Periodelabel (optioneel)',
      periodLabelPlaceholder: 'bijv. Q1 2024',
      calculating: 'Berekenen...',
      calculate: 'Berekenen',
      cancel: 'Annuleren',
      vatReturnTitle: 'BTW-aangifte {period}',
      periodTypeLabel: '{type} periode',
      file: 'Indienen',
      filing: 'Indienen...',
      downloadXml: 'XML Downloaden',
      checkStatus: 'Status controleren',
      returnsTitle: 'BTW-aangiftes',
      icpTitle: 'Opgaaf ICP (intracommunautaire prestaties)',
      icpDesc: 'Verplicht naast de BTW-aangifte wanneer je in het tijdvak intracommunautaire leveringen of diensten (0%) had.',
      icpNew: 'ICP berekenen',
      icpEmpty: 'Nog geen ICP-opgaven.',
      icpColTotal: 'Totaal prestaties',
      icpColLines: 'Afnemers',
      icpFile: 'Indienen',
      icpCalculated: 'Opgaaf ICP berekend: {count} afnemer(s), {total} totaal',
      checkingStatus: 'Controleren…',
      statusResult: 'Digipoort-status: {status}',
      suppletieButton: 'Suppletie controleren',
      suppletieChecking: 'Vergelijken met grootboek…',
      suppletieDeadlineLabel: 'Suppletie-deadline',
      vatNotFound: 'BTW-aangifte niet gevonden.',
      r5a: 'Verschuldigd (5a)',
      r5b: 'Voorbelasting (5b)',
      r5f: 'Te betalen / te ontvangen (5f)',
      rubrieken: 'Rubrieken',
      noRubrieken: 'Nog geen rubrieken berekend.',
      periodTypes: {
        quarterly: 'Kwartaal',
        monthly: 'Maandelijks',
        annual: 'Jaarlijks',
      },
      statuses: {
        draft: 'Concept',
        calculated: 'Berekend',
        filed: 'Ingediend',
        paid: 'Betaald',
      },
      // VAT list page
      listNewReturn: 'Nieuwe Aangifte Berekenen',
      listEmpty: 'Geen BTW-aangiften gevonden. Klik op "Nieuwe Aangifte Berekenen" om er een aan te maken.',
      colPeriod: 'Periode',
      colType: 'Type',
      colR5a: 'Verschuldigd (5a)',
      colR5b: 'Voorbelasting (5b)',
      colR5f: 'Totaal (5f)',
      colStatus: 'Status',
      // VAT detail page
      filedSuccess: 'BTW-aangifte succesvol ingediend',
      filingFailed: 'Indienen mislukt: {error}',
      fileToTax: 'Indienen bij Belastingdienst',
      filingDetails: 'Indieningsgegevens',
      digipoortKenmerk: 'Digipoort Kenmerk',
      filedAt: 'Ingediend op',
      filedBy: 'Ingediend door',
      notesSection: 'Opmerkingen',
    },

    // Documents page
    documents: {
      title: 'Documenten',
      upload: 'Uploaden',
      uploadDocument: 'Document Uploaden',
      uploadingDocument: 'Document Uploaden',
      dragDropOrClick: 'Sleep hier naartoe of klik om te uploaden',
      acceptedFormats: 'Geaccepteerde formaten: {formats}',
      uploading: 'Uploaden...',
      uploadAndProcess: 'Uploaden & Verwerken',
      cancel: 'Annuleren',
      processing: 'Verwerken',
      pending: 'In Behandeling',
      processed: 'Verwerkt',
      review: 'Beoordelen',
      linked: 'Gekoppeld',
      rejected: 'Afgewezen',
      failed: 'Mislukt',
      statusFilter: 'Status',
      noDocuments: 'Nog geen documenten.',
      columns: {
        file: 'Bestand',
        type: 'Type',
        status: 'Status',
        actions: 'Acties',
      },
      actions: {
        view: 'Bekijken',
        createBill: 'Inkoopfactuur Aanmaken',
        scan: 'Opnieuw Scannen',
        dismiss: 'Sluiten',
        linkContact: 'Contact Koppelen',
      },
      // Upload zone & OCR
      dropHint: 'Sleep factuurafbeeldingen hier naartoe — WeldAgent extraheert leverancier, bedragen, regelitems en totalen.',
      uploadInvoice: 'Factuur uploaden',
      noDocumentsInbox: 'Geen documenten in inbox',
      phaseUploading: 'Uploaden…',
      phaseProcessing: 'Scannen met WeldAgent…',
      phaseDone: 'Klaar',
      phaseFailed: 'Mislukt',
      // OCR result dialog
      ocrResult: 'OCR-resultaat',
      colFileName: 'Bestandsnaam',
      colType: 'Type',
      colSource: 'Bron',
      colSupplierDetected: 'Leverancier (gedetecteerd)',
      colAmountDetected: 'Bedrag (gedetecteerd)',
      colStatus: 'Status',
      groupPending: 'In Behandeling',
      groupProcessing: 'Verwerken',
      groupReview: 'Beoordelen',
      groupProcessed: 'Verwerkt',
      groupLinked: 'Gekoppeld',
      groupRejected: 'Afgewezen',
      groupOther: 'Overig',
      ocrSupplier: 'Leverancier',
      ocrMatched: 'Gevonden',
      ocrNoMatch: 'Niet gevonden',
      ocrInvoiceDetails: 'Factuurgegevens',
      ocrLineItems: 'Regelitems',
      ocrTotals: 'Totalen',
      ocrConfidence: 'Betrouwbaarheidsscores',
      ocrOverall: 'Totaal:',
      ocrSubtotal: 'Subtotaal',
      ocrTotalTax: 'Totaal BTW',
      ocrTotal: 'Totaal',
      ocrColDescription: 'Omschrijving',
      ocrColQty: 'Aantal',
      ocrColPrice: 'Prijs',
      ocrColVat: 'BTW %',
      ocrColTotal: 'Totaal',
      ocrFieldNumber: 'Nummer:',
      ocrFieldDate: 'Datum:',
      ocrFieldDueDate: 'Vervaldatum:',
      ocrFieldCurrency: 'Valuta:',
      ocrFieldReference: 'Referentie:',
      ocrFieldPaymentIban: 'Betaling IBAN:',
      ocrFieldName: 'Naam:',
      ocrFieldAddress: 'Adres:',
      ocrFieldBtw: 'BTW-nummer:',
      ocrFieldKvk: 'KvK-nummer:',
      ocrFieldIban: 'IBAN:',
      reject: 'Afwijzen',
      createSupplier: 'Leverancier aanmaken',
      createBill: 'Inkoopfactuur aanmaken',
      createSupplierFromOcr: 'Leverancier aanmaken vanuit OCR',
      supplierName: 'Naam',
      supplierBtw: 'BTW-nummer',
      supplierKvk: 'KvK-nummer',
      supplierIban: 'IBAN',
      supplierAddress: 'Adres',
      creating: 'Aanmaken…',
      processWithOcr: 'Verwerken met OCR',
      viewOcrResult: 'OCR-resultaat bekijken',
      acceptedFormatsLabel: 'JPG, PNG, WEBP',
      ocrVatLine: 'BTW {rate}% over {amount}',
    },

    // Entities page
    entities: {
      title: 'Administraties',
      newEntity: 'Nieuwe Administratie',
      entityName: 'Naam',
      entityCountry: 'Land',
      entityCurrency: 'Valuta',
      entityDescription: 'Omschrijving',
      noEntities: 'Geen administraties geconfigureerd.',
      creating: 'Aanmaken...',
      createEntity: 'Administratie Aanmaken',
      cancel: 'Annuleren',
      notFound: 'Administratie niet gevonden.',
      addEntityTitle: 'Nieuwe Administratie',
      basicDetails: 'Basisgegevens',
      financialSettings: 'Financiële Instellingen',
      namePlaceholder: 'Mijn Bedrijf BV',
      descriptionPlaceholder: 'Hoofdbedrijfsentiteit...',
      legalName: 'Officiële Naam',
      legalNamePlaceholder: 'Mijn Bedrijf B.V.',
      taxId: 'Belasting-ID / BTW-nummer',
      taxIdPlaceholder: 'NL000000000B01',
      fiscalYearEnd: 'Eindejaarsmaand Boekjaar',
      // Entities list page
      colName: 'Naam',
      colJurisdiction: 'Jurisdictie',
      colCurrency: 'Valuta',
      colTaxIds: 'BTW / Inschrijving',
      badgeDefault: 'Standaard',
      colKor: 'KOR',
      korEnabled: 'KOR actief — geen BTW op facturen en geen BTW-aangifte verschuldigd',
      korDisabled: 'KOR uit — normale BTW-regels van toepassing',
      korToggleOn: 'KOR ingeschakeld voor deze entiteit. Facturen krijgen de vrijstellingstekst en BTW-aangiftes zijn geblokkeerd zolang KOR actief is.',
      korToggleOff: 'KOR uitgeschakeld. Vanaf nu gelden de normale BTW-regels weer.',
      korUpdateFailed: 'KOR-instelling bijwerken mislukt',
      badgeInactive: 'Inactief',
      newEntity2: 'Nieuwe Entiteit',
      noEntities2: 'Nog geen entiteiten. Maak er een aan om WeldBooks te gaan gebruiken.',
      // Add entity page
      newLegalEntity: 'Nieuwe Rechtspersoon',
      newLegalEntityDesc: 'Bij het aanmaken van een entiteit worden het rekeningschema en de belastingtarieven van de jurisdictie-adapter ingevoerd.',
      displayName: 'Weergavenaam',
      displayNamePlaceholder: 'WeldCorp BV',
      legalNamePlaceholder2: 'WeldCorp Besloten Vennootschap',
      entityType: 'Entiteitstype',
      jurisdiction: 'Jurisdictie',
      baseCurrency: 'Basisvaluta',
      vatNumber: 'BTW-nummer',
      registrationNumber: 'Inschrijvingsnummer (KVK / CoC / HRB)',
      ibanLabel: 'IBAN',
      makeDefault: 'Dit als standaardentiteit van de werkruimte instellen',
      seedDefaults: 'Standaard rekeningschema en belastingtarieven voor deze jurisdictie invoeren',
      createEntity2: 'Entiteit aanmaken',
      creatingEntity: 'Aanmaken…',
      failedToCreate: 'Entiteit aanmaken mislukt',
    },

    // Recurring invoices list + detail pages
    recurringPage: {
      colContact: 'Contactpersoon',
      colFrequency: 'Frequentie',
      colNextDate: 'Volgende Datum',
      colAmount: 'Bedrag',
      colStatus: 'Status',
      statusActive: 'Actief',
      statusPaused: 'Gepauzeerd',
      newRecurring: 'Nieuwe Terugkerende Factuur',
      noRecurring: 'Geen terugkerende facturen gevonden',
      // Detail page
      notFound: 'Terugkerende factuur niet gevonden.',
      defaultName: 'Terugkerende Factuur',
      generating: 'Genereren...',
      generateNow: 'Nu Genereren',
      pause: 'Pauzeren',
      resume: 'Hervatten',
      generatedInvoice: 'Factuur gegenereerd: {number}',
      nextIssueDate: 'Volgende Uitgiftedatum',
      generatedCount: 'Aangemaakt Aantal',
      lastGenerated: 'Laatste Generatie',
      never: 'Nooit',
      schedule: 'Planning',
      frequency: 'Frequentie',
      dayOfMonth: 'Dag van de Maand',
      endDate: 'Einddatum',
      autoFinalize: 'Automatisch finaliseren',
      autoSend: 'Automatisch verzenden',
      yes: 'Ja',
      no: 'Nee',
      templateItems: 'Sjabloonregels',
      // Add / edit
      addTitle: 'Nieuwe Terugkerende Factuur',
      editTitle: 'Terugkerende Factuur Bewerken',
      comingSoon: 'Binnenkort beschikbaar',
    },

    // Bills list page
    billsPage: {
      searchPlaceholder: 'Inkoopfacturen zoeken...',
      newBill: 'Nieuwe Inkoopfactuur',
      groupOverdue: 'Achterstallig',
      groupApproved: 'Goedgekeurd',
      groupDraft: 'Concept',
      groupPaid: 'Betaald',
      groupOther: 'Overig',
      colNumber: 'Nummer',
      colSupplier: 'Leverancier',
      colDate: 'Datum',
      colDueDate: 'Vervaldatum',
      colTotal: 'Totaal',
      colStatus: 'Status',
      noBills: 'Geen inkoopfacturen gevonden',
    },

    // Accounts (Chart of Accounts) page
    accountsPage: {
      filterTypeLabel: 'Type',
      filterAsset: 'Activa',
      filterLiability: 'Passiva',
      filterEquity: 'Eigen vermogen',
      filterRevenue: 'Omzet',
      filterExpense: 'Kosten',
      newAccount: 'Nieuwe Rekening',
      groupAssets: 'Activa',
      groupLiabilities: 'Passiva',
      groupEquity: 'Eigen vermogen',
      groupRevenue: 'Omzet',
      groupExpenses: 'Kosten',
      colCode: 'Code',
      colName: 'Naam',
      colType: 'Type',
      colBalance: 'Saldo',
      noAccounts: 'Geen rekeningen gevonden',
    },

    // Customers list page
    customersPage: {
      searchPlaceholder: 'Klanten zoeken...',
      newCustomer: 'Nieuwe Klant',
      filterRoleLabel: 'Rol',
      filterBoth: 'Klant + leverancier (alleen)',
      colName: 'Naam',
      colEmail: 'E-mail',
      colRole: 'Rol',
      colVat: 'BTW-nummer',
      roleBoth: 'Klant + leverancier',
      noCustomers: 'Geen klanten gevonden',
    },

    // Suppliers list page
    suppliersPage: {
      searchPlaceholder: 'Leveranciers zoeken...',
      newSupplier: 'Nieuwe Leverancier',
      filterRoleLabel: 'Rol',
      filterBoth: 'Klant + leverancier (alleen)',
      colName: 'Naam',
      colEmail: 'E-mail',
      colRole: 'Rol',
      colVat: 'BTW-nummer',
      roleBoth: 'Klant + leverancier',
      noSuppliers: 'Geen leveranciers gevonden',
    },

    // Credit notes page
    creditNotesPage: {
      searchPlaceholder: 'Creditnota\'s zoeken...',
      colNumber: 'Nummer',
      colContact: 'Contactpersoon',
      colDate: 'Datum',
      colForInvoice: 'Voor Factuur',
      colTotal: 'Totaal',
      colStatus: 'Status',
      viewSource: 'Bronsfactuur bekijken',
      noCreditNotes: 'Nog geen creditnota\'s. Open een gefinaliseerde factuur en gebruik "Creditnota aanmaken".',
    },

    // KPI cards
    kpiCards: {
      revenueMonth: 'Omzet (maand)',
      revenueYear: 'Omzet (jaar)',
      expensesMonth: 'Kosten (maand)',
      profitMonth: 'Winst (maand)',
      outstandingReceivables: 'Openstaande Debiteuren',
      overdueReceivables: 'Achterstallige Debiteuren',
      outstandingPayables: 'Openstaande Crediteuren',
      pendingDocuments: 'In Behandeling',
      invoices: '{count} facturen',
      bills: '{count} inkoopfacturen',
    },

    // Gedeelde statusbadge-labels die op meerdere pagina's worden gebruikt
    statusLabels: {
      // Factuurstatussen (invoices/[id]/page, invoices/page, credit-notes/page)
      invoice: {
        draft: 'Concept',
        sent: 'Verzonden',
        paid: 'Betaald',
        overdue: 'Achterstallig',
        partial: 'Gedeeltelijk',
        cancelled: 'Geannuleerd',
        finalized: 'Gefinaliseerd',
        fallback: 'Factuur',
      },
      // Journaalpoststatus (journal/[id]/page)
      journalEntry: {
        draft: 'Concept',
        posted: 'Geboekt',
        reversed: 'Teruggedraaid',
        fallback: 'Journaalpost',
        sourceManual: 'Handmatig',
      },
      // BTW-aangiftestatussen die nog niet gedekt worden door vat.statuses
      vatReturn: {
        calculated: 'Berekend',
        reviewed: 'Beoordeeld',
        accepted: 'Geaccepteerd',
        rejected: 'Afgewezen',
      },
      // Terugkerende factuurstatussen (recurring/[id]/page)
      recurringInvoice: {
        active: 'Actief',
        paused: 'Gepauzeerd',
        ended: 'Beëindigd',
      },
      // Generieke terugval voor onbekende tegenpartij (banking/reconciliation/page)
      counterpartyUnknown: 'Onbekend',
    },

    // WeldBooks-layout
    layout: {
      appNotInstalled: 'App niet geïnstalleerd',
    },

    // WeldBooks-breadcrumb-koptekst segmentlabels
    header: {
      weldbooks: 'WeldBooks',
      invoices: 'Facturen',
      creditNotes: 'Creditnota\'s',
      bills: 'Inkoopfacturen',
      recurring: 'Terugkerende Facturen',
      contacts: 'Contacten',
      accounts: 'Rekeningschema',
      journal: 'Journaalposten',
      vat: 'BTW-aangiftes',
      banking: 'Bank',
      transactions: 'Transacties',
      reconciliation: 'Bankafstemmingen',
      rules: 'Regels',
      import: 'Importeren',
      documents: 'Documenten',
      customers: 'Klanten',
      suppliers: 'Leveranciers',
      entities: 'Entiteiten',
      reports: 'Rapporten',
      profitLoss: 'Winst & Verlies',
      balanceSheet: 'Balans',
      trialBalance: 'Proefbalans',
      agedReceivables: 'Verouderde Debiteuren',
      agedPayables: 'Verouderde Crediteuren',
      cashFlow: 'Kasstroomoverzicht',
      generalLedger: 'Grootboek',
      settings: 'Instellingen',
      dashboard: 'Dashboard',
      add: 'Nieuw',
      edit: 'Bewerken',
      detail: 'Detail',
    },
  };
