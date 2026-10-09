/**
 * WeldBooks US: cash/accrual basis, comparatives, export, tax worksheet.
 */
export const weldbooksUsReports = {
  // Rapportopties
  toolbar: 'Rapportopties',
  basis: 'Basis',
  accrual: 'Accrual',
  cash: 'Kasbasis',
  basisAccrual: 'Accrualbasis',
  basisCash: 'Kasbasis',
  compare: 'Vergelijken',
  compareNone: 'Geen vergelijking',
  comparePriorPeriod: 'Vorige periode',
  comparePriorYear: 'Vorig jaar',
  columns: 'Kolommen',
  columnsTotal: 'Alleen totaal',
  columnsMonths: 'Per maand',
  columnsQuarters: 'Per kwartaal',
  class: 'Klasse',
  allClasses: 'Alle klassen',
  location: 'Locatie',
  allLocations: 'Alle locaties',
  updating: 'Bijwerken…',
  export: 'Exporteren',
  exporting: 'Exporteren…',
  exportCsv: 'CSV downloaden',
  exportPdf: 'PDF downloaden',
  exportFailed: 'Het rapport kon niet worden geëxporteerd',
  loadError: 'Het rapport kon niet worden geladen.',
  retry: 'Opnieuw proberen',
  noActivity: 'In deze periode is niets geboekt.',

  // Kolomkoppen
  colAccount: 'Rekening',
  colChange: 'Wijziging',
  colChangePercent: 'Wijziging %',
  columnTotal: 'Totaal',
  quarterHeading: 'K{n} {year}',
  periodHeading: 'P{n} {year}',
  asOfDate: 'Per {date}',

  // Rijen van de overzichten
  statement: {
    income: 'Opbrengsten',
    totalIncome: 'Totaal opbrengsten',
    costOfGoodsSold: 'Kostprijs van de omzet',
    totalCostOfGoodsSold: 'Totaal kostprijs van de omzet',
    grossProfit: 'Brutowinst',
    expenses: 'Kosten',
    totalExpenses: 'Totaal kosten',
    netOperatingIncome: 'Netto bedrijfsresultaat',
    otherIncome: 'Overige opbrengsten',
    totalOtherIncome: 'Totaal overige opbrengsten',
    otherExpenses: 'Overige kosten',
    totalOtherExpenses: 'Totaal overige kosten',
    netOtherIncome: 'Netto overige opbrengsten',
    netIncome: 'Nettoresultaat',
    assets: 'Activa',
    totalAssets: 'Totaal activa',
    liabilities: 'Passiva',
    totalLiabilities: 'Totaal passiva',
    equity: 'Eigen vermogen',
    totalEquity: 'Totaal eigen vermogen',
    totalLiabilitiesAndEquity: 'Totaal passiva en eigen vermogen',
    retainedEarningsEarlier: 'Ingehouden winst (eerdere jaren)',
    netIncomeThisYear: 'Nettoresultaat (dit boekjaar)',
  },
  notBalanced: 'Activa en passiva plus eigen vermogen verschillen {amount}.',
  trialBalanceOff: 'Het totaal van debet en credit is niet gelijk.',

  // Grootboek
  selectAccountFirst: 'Kies een rekening om het grootboek te zien.',
  balanceNote: 'Saldi zijn debet min credit.',
  pageOf: 'Pagina {page} van {total} ({count} regels)',
  previous: 'Vorige',
  next: 'Volgende',

  // Kasstroom
  vsComparison: 'Vergelijking: {amount} ({change})',
  comparisonPeriod: 'Vergelijkingsperiode {period}',

  // Ouderdomsanalyse
  documentsCount: '{count} documenten',
  byContact: 'Per {contact}',
  openDocuments: 'Openstaande documenten',

  // Pagina-onderdelen van de PDF
  pdf: {
    basisCash: 'Kasbasis',
    basisAccrual: 'Accrualbasis',
    amountsIn: 'Bedragen in {currency}',
    generated: 'Aangemaakt op {date}',
    page: 'Pagina {page} van {total}',
    dba: 'DBA',
  },

  // Werkblad voor de belastingaangifte (VS)
  worksheet: {
    title: 'Werkblad belastingaangifte',
    cardDescription: 'Je boekhouding van een boekjaar, regel voor regel zoals die op de inkomstenbelastingaangifte komen',
    description:
      'De proefbalans van het boekjaar gegroepeerd naar de regels van {form}, met de rekeningen achter elke regel, voor de accountant die de aangifte opstelt.',
    usOnly: 'Het werkblad voor de belastingaangifte is beschikbaar voor Amerikaanse entiteiten.',
    fiscalYear: 'Boekjaar',
    includeZero: 'Rekeningen zonder activiteit meenemen',
    unmappedTitle: 'Rekeningen zonder regel op deze aangifte ({count})',
    unmappedDescription:
      'Deze rekeningen hebben activiteit maar geen regel op {form}, dus ze staan niet in de regels hieronder. Koppel ze zodat het werkblad sluit.',
    mapAccounts: 'Rekeningen koppelen',
    reasonNone: 'Geen belastingregel',
    reasonOtherForm: 'Regel van een andere aangifte',
    reasonUnknownLine: 'Onbekende regel',
    summaryTitle: 'Aansluiting op de boekhouding',
    reconciles: 'Sluit aan',
    doesNotReconcile: 'Sluit niet aan',
    reconcilesHelp:
      'Het nettoresultaat volgens de boekhouding is gelijk aan het nettoresultaat van de regels, min wat niet aftrekbaar is, plus de niet gekoppelde rekeningen.',
    doesNotReconcileHelp:
      'Het nettoresultaat volgens de boekhouding wijkt af van het nettoresultaat van de regels, min wat niet aftrekbaar is, plus de niet gekoppelde rekeningen. Controleer de rekeningen hierboven.',
    totalIncome: 'Opbrengsten',
    totalOtherIncome: 'Overige opbrengsten',
    totalCogs: 'Kostprijs van de omzet',
    totalDeductions: 'Aftrekposten',
    netIncomeFromLines: 'Nettoresultaat volgens de regels',
    notDeductibleTotal: 'Niet aftrekbaar',
    unmappedNetIncome: 'Niet gekoppelde rekeningen (opbrengsten min kosten)',
    netIncomePerBooks: 'Nettoresultaat volgens de boekhouding',
    linesTitle: 'Regels van de aangifte',
    expandAll: 'Toon alle rekeningen',
    collapseAll: 'Verberg rekeningen',
    beginning: 'Begin van het jaar',
    deductibleNote: '{percent}% aftrekbaar: {deductible} aftrekbaar, {nonDeductible} niet.',
    nonDeductibleOn: 'De rest komt op regel {line}.',
  },
};
