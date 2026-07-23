export const accounts = {
    title: 'Rekeningen',
    chartOfAccounts: 'Rekeningschema',
    accountNumber: 'Rekeningcode',
    accountName: 'Rekeningnaam',
    accountType: 'Rekeningtype',
    normalBalance: 'Normaal saldo',
    currentBalance: 'Huidig saldo',
    description: 'Beheer uw financiële rekeningstructuur',
    descriptionField: 'Omschrijving',
    subtype: 'Subtype',
    isActive: 'Is actief',
    isCashAccount: 'Kasrekening',
    isBankAccount: 'Bankrekening',
    types: {
      asset: 'Activa',
      liability: 'Passiva',
      equity: 'Eigen vermogen',
      revenue: 'Opbrengsten',
      expense: 'Kosten'
    },
    subtypes: {
      currentAsset: 'Vlottende activa',
      fixedAsset: 'Vaste activa',
      currentLiability: 'Kortlopende schulden',
      longTermLiability: 'Langlopende schulden',
      ownersEquity: 'Eigen vermogen',
      operatingRevenue: 'Bedrijfsopbrengsten',
      operatingExpense: 'Bedrijfskosten',
      otherRevenue: 'Overige opbrengsten',
      otherExpense: 'Overige kosten',
      cash: 'Kas',
      bank: 'Bank',
      cogs: 'Kostprijs verkopen',
      equity: 'Eigen vermogen'
    },
    actions: {
      newAccount: 'Nieuwe rekening',
      editAccount: 'Rekening bewerken',
      deleteAccount: 'Rekening verwijderen',
      activateAccount: 'Rekening activeren',
      deactivateAccount: 'Rekening deactiveren'
    },
    messages: {
      accountCreated: 'Rekening succesvol aangemaakt',
      accountUpdated: 'Rekening succesvol bijgewerkt',
      accountDeleted: 'Rekening succesvol verwijderd',
      cannotDeleteUsedAccount: 'Kan rekening die gebruikt is in transacties niet verwijderen',
      accountCodeExists: 'Rekeningcode bestaat al. Gebruik een andere code.'
    },
    help: {
      accountTypes: {
        title: 'Rekeningtypen',
        content: 'Activa: Middelen die eigendom zijn van het bedrijf (kas, voorraad, apparatuur). Passiva: Schulden van het bedrijf (leningen, crediteuren). Eigen Vermogen: Aandeel van de eigenaar in het bedrijf. Opbrengsten: Inkomsten uit bedrijfsactiviteiten. Kosten: Uitgaven voor het runnen van het bedrijf.'
      },
      normalBalance: {
        title: 'Normaal Saldo',
        content: 'Elk rekeningtype heeft een normale saldo-kant. Activa en Kosten hebben normaal een debetsaldo, terwijl Passiva, Eigen Vermogen en Opbrengsten normaal een creditsaldo hebben.'
      },
      accountCode: {
        title: 'Rekeningcode Formaat',
        content: 'Gebruik een systematisch nummeringsschema: 1000-1999 voor Activa, 2000-2999 voor Passiva, 3000-3999 voor Eigen Vermogen, 4000-4999 voor Opbrengsten, 5000-9999 voor Kosten.'
      }
    }
  };
