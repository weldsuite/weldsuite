export const journal = {
    title: 'Journaal',
    entries: 'Journaalposten',
    entry: 'Journaalpost',
    entryNumber: 'Postnummer',
    entryDate: 'Boekdatum',
    entryType: 'Posttype',
    debit: 'Debet',
    credit: 'Credit',
    account: 'Rekening',
    memo: 'Memo',
    attachment: 'Bijlage',
    posted: 'Geboekt',
    balanced: 'In balans',
    unbalanced: 'Niet in balans',
    difference: 'Verschil',

    // Form sections
    sections: {
      entryInformation: 'Postinformatie',
      journalLines: 'Journaalregels',
      additionalNotes: 'Aanvullende Notities',
    },

    // Form labels
    description: 'Omschrijving',
    date: 'Datum',
    type: 'Posttype',
    reference: 'Referentienummer',
    referenceNumber: 'Referentienummer',
    notes: 'Notities',
    lines: 'Regels',
    totalDebits: 'Totaal Debet',
    totalCredits: 'Totaal Credit',
    totals: 'Totalen',

    // Placeholders
    placeholders: {
      description: 'bijv., Maandelijkse huurbetaling',
      selectDate: 'Selecteer datum',
      reference: 'Optioneel referentienummer',
      notes: 'Aanvullende notities of opmerkingen over deze journaalpost',
      selectAccount: 'Selecteer rekening',
      lineDescription: 'Regelomschrijving',
      debit: '0,00',
      credit: '0,00',
    },

    // Entry types
    types: {
      manual: 'Handmatig',
      adjustment: 'Correctie',
      closing: 'Afsluiting',
      automatic: 'Automatisch'
    },

    // Type descriptions
    typeDescriptions: {
      manual: 'Handmatig aangemaakte journaalposten voor reguliere transacties',
      adjustment: 'Correctieposten voor overlopende posten, uitstel of correcties',
      closing: 'Jaareinde of periode-einde afsluitingsposten om tijdelijke rekeningen te resetten',
    },

    // Column headers
    columns: {
      account: 'Rekening',
      description: 'Omschrijving',
      debit: 'Debet',
      credit: 'Credit',
    },

    // Info texts
    infoTexts: {
      balancedEntry: 'Een gebalanceerde post betekent dat het totaal debet gelijk is aan het totaal credit. Dit is een fundamenteel principe van dubbel boekhouden.',
      debitTooltip: 'Linkerkant van de boeking. Verhoogt Activa en Kosten, verlaagt Passiva, Eigen Vermogen en Opbrengsten.',
      creditTooltip: 'Rechterkant van de boeking. Verhoogt Passiva, Eigen Vermogen en Opbrengsten, verlaagt Activa en Kosten.',
      entryTypes: 'Journaalposttypen',
    },

    // Status messages
    status: {
      balanced: 'Post is in balans! Debet en credit zijn gelijk.',
      unbalanced: 'Post is niet in balans. Verschil: ',
      notBalanced: 'Post is niet in balans. Debet moet gelijk zijn aan credit.',
    },

    // Buttons
    buttons: {
      addLine: 'Regel Toevoegen',
      removeLine: 'Regel Verwijderen',
      saveAsDraft: 'Opslaan als Concept',
      saveChanges: 'Wijzigingen Opslaan',
      backToJournal: 'Terug naar journaalposten',
    },

    // Validation
    validation: {
      descriptionRequired: 'Omschrijving is verplicht',
      entryMustBeBalanced: 'Post moet in balans zijn (debet moet gelijk zijn aan credit)',
      minimumTwoLines: 'Minimaal twee journaalregels zijn vereist',
      validationError: 'Validatiefout',
    },

    // Summary
    summary: {
      entrySummary: 'Post Overzicht',
      untitledEntry: 'Naamloze Post',
      linesCount: '{count} regels',
      yes: 'Ja',
      no: 'Nee',
    },

    actions: {
      newEntry: 'Nieuwe post',
      postEntry: 'Post boeken',
      reverseEntry: 'Post storneren',
      copyEntry: 'Post kopiëren',
      viewEntry: 'Post bekijken',
      createNewEntry: 'Nieuwe Journaalpost Aanmaken',
      editEntry: 'Journaalpost Bewerken',
      editing: 'Bewerken',
    },

    messages: {
      entryPosted: 'Journaalpost succesvol geboekt',
      entryReversed: 'Journaalpost succesvol gestorneerd',
      mustBalance: 'Totaal debet moet gelijk zijn aan totaal credit',
      minimumTwoLines: 'Journaalpost moet minimaal 2 regels bevatten',
      entrySaved: 'Journaalpost succesvol opgeslagen!',
      entrySavedDesc: '{description} is opgeslagen als concept.',
      error: 'Fout',
      failedToSave: 'Journaalpost opslaan mislukt',
    }
  };
