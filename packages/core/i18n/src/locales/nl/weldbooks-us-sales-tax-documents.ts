/**
 * WeldBooks VS: sales tax op documenten (zie en/weldbooks-us-sales-tax-documents.ts).
 * Staat onder `weldbooksUs.salesTax.documents`.
 */
export const weldbooksUsSalesTaxDocuments = {
  taxCodes: {
    general: 'Algemene goederen',
    saas: 'Software als dienst (SaaS)',
    digital_goods: 'Digitale goederen',
    services: 'Diensten',
    professional_services: 'Professionele diensten',
    shipping: 'Verzending',
    handling: 'Afhandeling',
    food_grocery: 'Boodschappen',
    prepared_food: 'Bereid voedsel',
    clothing: 'Kleding',
    prescription_drugs: 'Receptgeneesmiddelen',
    non_taxable: 'Niet belastbaar',
  },

  engines: {
    manual: 'Handmatige tarieven',
    stripe_tax: 'Stripe Tax',
    avalara: 'Avalara AvaTax',
  },

  levels: {
    state: 'Staat',
    county: 'County',
    city: 'Stad',
    district: 'District',
  },

  line: {
    product: 'Product',
    productPlaceholder: 'Kies een product (optioneel)',
    productSearch: 'Producten zoeken',
    productEmpty: 'Geen producten gevonden',
    taxOptions: 'Sales tax-opties',
    taxCode: 'Belastingcode',
    taxCodeDefault: 'Standaard ({code})',
    use: 'Gebruikt door',
    useDefault: 'Standaard van de klant ({use})',
    useBusiness: 'Zakelijk',
    usePersonal: 'Privé',
    taxIncluded: 'Prijs is inclusief sales tax',
    overrideTax: 'Belasting overschrijven',
    overrideAmount: 'Belastingbedrag',
    overrideReason: 'Reden',
    overrideReasonPlaceholder: 'Waarom is de belasting met de hand ingesteld?',
    overrideReasonRequired: 'Geef een reden: een overschreven belasting heeft er een nodig.',
    overrideAmountInvalid: 'Vul een bedrag van nul of meer in.',
    overrideHelp: 'Dit bedrag vervangt de berekende belasting voor de regel. Het blijft staan als je het concept bewerkt.',
    overridden: 'Overschreven',
    lineTax: 'Sales tax {amount}',
    lineTaxRate: 'Sales tax {amount} ({rate}%)',
    followsOriginal: 'De belasting van deze regel volgt de oorspronkelijke factuur.',
    class: 'Klasse',
    location: 'Locatie',
    noDimension: 'Geen',
    inactiveValue: '{name} (inactief)',
  },

  panel: {
    calculating: 'Berekenen…',
    lastCalculation: 'De laatste berekening wordt getoond. De laatste wijziging kon niet worden berekend.',
    estimateNote:
      'Berekend door je sales tax-engine voor het afleveradres. Het definitieve bedrag staat vast zodra het document is afgerond.',
    noTaxCharged: 'Op dit document wordt geen sales tax berekend.',
    rateOn: '{rate}% over {amount}',
    useTaxTitle: 'Opgebouwde use tax',
    useTaxNote: 'Use tax bouw je zelf op en draag je af aan de staat. Het is geen onderdeel van wat de leverancier krijgt.',
    warningsTitle: 'Controleer de sales tax',
    previewFailed: 'De belasting kon nu niet worden berekend.',
    engineUnavailableTitle: 'De sales tax-engine is niet beschikbaar',
    engineUnavailable:
      'De belastingengine kon de belasting niet berekenen. Je kunt een concept opslaan, maar het kan pas worden afgerond of verstuurd als de engine antwoordt. Belasting wordt nooit als nul geboekt.',
    addressNeededTitle: 'Voeg een afleveradres toe',
    addressNeeded:
      'Vul een staat en ZIP-code voor het afleveradres in (of een factuuradres daarmee) om de sales tax te berekenen. Zonder kan de factuur niet worden afgerond.',
    openSettings: 'Sales tax-instellingen openen',
    exemptAmount: '{amount} vrijgesteld',
  },

  exempt: {
    reason: 'Vrijgestelde verkoop: {reason}.',
    reasonWithCertificate: 'Vrijgestelde verkoop: {reason}. Certificaatnr. {number}.',
    certificateOnly: 'Vrijgestelde verkoop. Certificaatnr. {number}.',
    notice: 'Vrijgestelde verkoop.',
  },

  warnings: {
    not_registered_in_state: 'Geen sales tax: je bent niet geregistreerd om die te innen in {state}.',
    address_unverified: 'Het adres kon niet worden geverifieerd, dus het tarief van de staat is gebruikt.',
    no_ship_to: 'Er is geen afleveradres opgegeven, dus het factuuradres is gebruikt.',
    certificate_expired: 'Het vrijstellingscertificaat van de klant is verlopen, dus er is belasting berekend.',
    certificate_missing: 'Er is geen geldig vrijstellingscertificaat gevonden voor deze verkoop.',
    marketplace_facilitated: 'Verkocht via een marktplaats die de belasting int, dus er is geen berekend.',
    zone_not_found: 'Geen belastingzone komt overeen met het afleveradres, dus het tarief van de staat is gebruikt.',
    no_use_tax_registration: 'Use tax is opgebouwd in een staat waar je geen actieve registratie hebt.',
    rates_not_configured: 'Voor dit adres zijn geen sales tax-tarieven ingesteld. Voeg ze toe in de sales tax-instellingen.',
    override_not_applied: 'Een met de hand ingesteld belastingbedrag kon niet worden toegepast.',
    provider_rate_date_ignored:
      'De huidige tarieven zijn gebruikt: je belastingprovider kan een berekening van zo lang geleden niet dateren.',
    provider_not_supported: 'Je belastingprovider ondersteunt deze verkoop niet.',
    provider_nexus_missing: 'Je belastingprovider heeft geen registratie voor deze staat.',
    tax_engine_unavailable:
      'De belastingengine was niet beschikbaar, dus er is nog geen sales tax berekend. De factuur kan pas worden afgerond als dat wel zo is.',
    commit_failed: 'De factuur kon niet worden vastgelegd bij je belastingprovider.',
    reverse_failed: 'De belastingprovider kon de belasting van dit document niet terugdraaien.',
    reverse_unsupported: 'De belastingprovider kan de belasting van dit document niet terugdraaien.',
    reverse_skipped: 'De belasting van dit document is niet teruggedraaid bij je belastingprovider.',
    stateFallback: 'de staat van het afleveradres',
  },

  errors: {
    addressRequired:
      'Voor de sales tax is een afleveradres (of factuuradres) met een staat en ZIP-code nodig. Voeg dat toe aan de factuur voordat je hem afrondt.',
    engineUnavailable:
      'De sales tax-engine kon de belasting niet berekenen, dus er is niets geboekt. Controleer de sales tax-instellingen.',
    engineUnavailableRetry:
      'De sales tax-engine is nu niet bereikbaar, dus er is niets geboekt. Probeer het zo opnieuw.',
    ratesNotConfigured:
      'Voor deze staat zijn geen sales tax-tarieven ingesteld. Voeg de staat toe aan je instanties, met de tarieven, voordat je afrondt.',
    useTaxUnsupported:
      'Je belastingengine kan geen use tax berekenen. Voeg de tarieven van de staat toe in de sales tax-instellingen, of wissel van engine.',
    notCalculated: 'De sales tax is nog niet berekend. Open de factuur opnieuw en probeer het nog eens.',
    creditLineNotOnOriginal: 'Een regel van deze creditfactuur staat niet op de oorspronkelijke factuur.',
    commitNotApplicable: 'Deze factuur hoeft niet te worden vastgelegd bij een belastingprovider.',
    editAddress: 'Adressen van de factuur bewerken',
    openSettings: 'Sales tax-instellingen openen',
    openAgencies: 'Sales tax-instanties openen',
  },

  shipFrom: {
    title: 'Sales tax',
    marketplace: 'Verkocht via een marktplaatsfaciliteerder',
    marketplaceHelp:
      'De marktplaats int en draagt de belasting af, dus hier wordt er geen berekend. De verkoop telt wel mee voor je nexusdrempels.',
    differentOrigin: 'Verzenden vanaf een ander adres',
    originHelp:
      'De herkomst telt in staten die belasten naar de locatie van de verkoper. Standaard is het je bedrijfsadres.',
    originDefault: 'Je bedrijfsadres wordt gebruikt: {address}',
    originNone: 'Voeg je bedrijfsadres toe in de entiteitsinstellingen om het als herkomst te gebruiken.',
    shipFromAddress: 'Verzendadres',
  },

  detail: {
    taxTitle: 'Sales tax',
    engine: 'Belastingengine',
    calculatedAt: 'Berekend',
    providerRecord: 'Vastgelegd bij provider',
    committedAt: 'Vastgelegd op {date}',
    notCommitted: 'Nog niet vastgelegd bij de provider',
    retryCommit: 'Belasting opnieuw vastleggen',
    retrying: 'Opnieuw proberen…',
    commitCommitted: 'De factuur is vastgelegd bij je belastingprovider.',
    commitReversed: 'De belasting van de creditfactuur is teruggedraaid bij je belastingprovider.',
    commitAlready: 'Dit document was al vastgelegd bij je belastingprovider.',
    commitNotApplicable: 'Dit document hoeft niet te worden vastgelegd bij een belastingprovider.',
    commitFailed: 'Vastleggen bij je belastingprovider is mislukt.',
    warningsTitle: 'Controleer de sales tax',
    lineFlags: {
      taxIncluded: 'Belasting inbegrepen',
      overridden: 'Belasting overschreven: {reason}',
      business: 'Zakelijk gebruik',
      personal: 'Privégebruik',
    },
    createCreditMemo: '{name} maken',
    creditMemoCreated: 'Concept {number} gemaakt.',
    creditMemoFailed: 'De creditfactuur kon niet worden gemaakt.',
    creditMemoNote: 'De belasting van een creditfactuur draait de belasting van de oorspronkelijke factuur terug, regel voor regel.',
    viewOriginal: 'Oorspronkelijke factuur bekijken',
    marketplaceNote: 'Verkocht via een marktplaatsfaciliteerder: geen belasting berekend.',
  },

  form: {
    creditMemoTitle: 'Creditfactuur bewerken',
    creditMemoNote:
      'De belasting van een creditfactuur volgt de factuur die je crediteert. Pas aantallen of prijzen aan om een deel van een regel te crediteren, of verwijder regels die je niet crediteert.',
    creditMemoUpdated: 'Creditfactuur bijgewerkt',
  },

  bill: {
    vendorTax: 'Door leverancier berekende sales tax (%)',
    vendorTaxLabel: 'Betaalde sales tax (onderdeel van de kosten)',
    costNote: 'Sales tax die een leverancier berekent is onderdeel van de kosten van het artikel, geen belasting die je kunt terugvragen.',
    deliveryTitle: 'Afleveradres',
    deliveryHelp: 'Waar de goederen zijn afgeleverd. Het bepaalt het use tax-tarief. Standaard je bedrijfsadres.',
    deliveryDifferent: 'Afgeleverd op een ander adres dan mijn bedrijfsadres',
    taxCode: 'Belastingcode',
    accrueUseTax: 'Use tax opbouwen',
    accrueUseTaxHelp: 'De leverancier heeft geen sales tax berekend: bouw use tax op voor het afleveradres.',
    form1099Box: '1099-vak',
    form1099Default: 'Standaard van de rekening ({box})',
    form1099DefaultNone: 'Standaard van de rekening (geen)',
    form1099Omit: 'Niet opnemen in 1099',
    useTaxTitle: 'Opgebouwde use tax',
    useTaxNote: 'Opgebouwd bij goedkeuring en met je aangifte afgedragen aan de staat. Geen onderdeel van de rekening van de leverancier.',
    createFixedAsset: 'Vast actief maken',
    lineCostWithTax: 'Kosten incl. belasting',
    approveFailed: 'De inkoopfactuur kon niet worden goedgekeurd',
    removeLine: 'Regel verwijderen',
  },

  recurring: {
    pageTitle: 'Nieuwe terugkerende factuur',
    editTitle: 'Terugkerende factuur bewerken',
    name: 'Naam',
    namePlaceholder: 'Maandelijkse retainer',
    customer: 'Klant',
    selectCustomer: 'Selecteer een klant',
    frequency: 'Frequentie',
    frequencies: {
      weekly: 'Wekelijks',
      biweekly: 'Elke twee weken',
      monthly: 'Maandelijks',
      quarterly: 'Per kwartaal',
      biannually: 'Twee keer per jaar',
      yearly: 'Jaarlijks',
    },
    nextIssueDate: 'Volgende factuurdatum',
    endDate: 'Einddatum (optioneel)',
    autoFinalize: 'Elke factuur automatisch afronden',
    autoSend: 'Elke factuur automatisch versturen',
    paymentTermsDays: 'Betalingstermijn (dagen)',
    reference: 'Referentie',
    notes: 'Notities',
    lineItems: 'Factuurregels',
    addLine: 'Regel toevoegen',
    description: 'Omschrijving',
    quantity: 'Aantal',
    unitPrice: 'Stuksprijs',
    taxNote: 'De belasting wordt berekend zodra elke factuur wordt gemaakt, vanuit het adres van de klant op die dag.',
    save: 'Terugkerende factuur opslaan',
    saving: 'Opslaan…',
    created: 'Terugkerende factuur aangemaakt',
    updated: 'Terugkerende factuur bijgewerkt',
    saveFailed: 'De terugkerende factuur kon niet worden opgeslagen',
    atLeastOneLine: 'Voeg minstens één regel toe',
    customerRequired: 'Kies een klant',
    dateRequired: 'Kies een datum',
    descriptionRequired: 'Vul een omschrijving in',
    finalizeFailedTitle: 'De factuur is gemaakt maar niet afgerond',
    finalizeFailed: '{message} De factuur blijft een concept. Open hem om het probleem op te lossen en hem af te ronden.',
    openInvoice: 'Factuur openen',
    editTemplate: 'Sjabloon bewerken',
    cancelEdit: 'Annuleren',
    shipFromTitle: 'Verzenden vanaf',
  },

  journal: {
    class: 'Klasse',
    location: 'Locatie',
  },

  pdf: {
    jurisdictionTax: '{tax} – {jurisdiction} {rate}%',
  },

  createEntity: {
    usTitle: 'Een Amerikaanse entiteit instellen',
    usBody:
      'Een Amerikaanse entiteit heeft een rechtsvorm, belastingclassificatie en sales tax-instellingen nodig, daarom heeft ze een eigen installatiegids.',
    usButton: 'VS-installatie starten',
  },
};
