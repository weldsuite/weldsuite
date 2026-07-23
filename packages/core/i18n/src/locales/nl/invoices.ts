export const invoices = {
    title: 'Facturen',
    invoice: 'Factuur',
    invoiceNumber: 'Factuurnummer',
    customer: 'Klant',
    issueDate: 'Uitgiftedatum',
    dueDate: 'Vervaldatum',
    paymentTerms: 'Betalingsvoorwaarden',
    items: 'Items',
    item: 'Item',
    quantity: 'Hoeveelheid',
    unitPrice: 'Stukprijs',
    discount: 'Korting',
    lineTotal: 'Regeltotaal',
    subtotal: 'Subtotaal',
    tax: 'BTW',
    total: 'Totaal',
    balanceDue: 'Openstaand saldo',
    paidAmount: 'Betaald bedrag',
    paymentMethod: 'Betaalmethode',
    actions: {
      newInvoice: 'Nieuwe factuur',
      importInvoice: 'Factuur importeren',
      editInvoice: 'Factuur bewerken',
      deleteInvoice: 'Factuur verwijderen',
      sendInvoice: 'Factuur verzenden',
      printInvoice: 'Factuur afdrukken',
      duplicateInvoice: 'Factuur dupliceren',
      convertToCredit: 'Omzetten naar creditnota',
      recordPayment: 'Betaling registreren',
      viewInvoice: 'Factuur bekijken'
    },
    status: {
      draft: 'Concept',
      sent: 'Verzonden',
      viewed: 'Bekeken',
      paid: 'Betaald',
      partiallyPaid: 'Gedeeltelijk betaald',
      overdue: 'Achterstallig',
      cancelled: 'Geannuleerd'
    },

    // Stats
    stats: {
      totalInvoices: 'Totaal Facturen',
      totalInvoicesDesc: 'Alle facturen',
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
      sent: 'Verzonden',
      unpaid: 'Onbetaald',
      paid: 'Betaald',
      overdue: 'Achterstallig',
    },

    // Table headers
    table: {
      invoiceNumber: 'Factuur #',
      customer: 'Klant',
      issueDate: 'Uitgiftedatum',
      dueDate: 'Vervaldatum',
      status: 'Status',
      total: 'Totaal',
      balanceDue: 'Openstaand',
      unknownCustomer: 'Onbekende Klant',
    },

    // Actions menu
    actionsMenu: {
      openMenu: 'Menu openen',
      actions: 'Acties',
      viewInvoice: 'Factuur Bekijken',
      sendByEmail: 'Verzenden per E-mail',
      duplicate: 'Dupliceren',
      downloadPdf: 'PDF Downloaden',
      recordPayment: 'Betaling Registreren',
      duplicateFeature: 'Dupliceerfunctie komt binnenkort',
      pdfDownloadFeature: 'PDF-downloadfunctie komt binnenkort',
      paymentRecordingFeature: 'Betalingsregistratiefunctie komt binnenkort',
    },

    // Loading and empty states
    loadingInvoices: 'Facturen laden...',
    selectAdministration: 'Selecteer een administratie om facturen te bekijken.',

    messages: {
      invoiceCreated: 'Factuur succesvol aangemaakt',
      invoiceSent: 'Factuur succesvol verzonden',
      invoiceStatusUpdated: 'Factuur {status} succesvol',
      paymentRecorded: 'Betaling succesvol geregistreerd',
      cannotEditSent: 'Kan verzonden factuur niet bewerken',
      confirmSend: 'Weet u zeker dat u deze factuur wilt verzenden?',
      updateFailed: 'Bijwerken factuur mislukt',
    }
  };
