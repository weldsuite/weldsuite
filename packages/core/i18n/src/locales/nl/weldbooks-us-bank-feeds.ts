/**
 * WeldBooks US: bank feed connections.
 */
export const weldbooksUsBankFeeds = {
  title: 'Bankkoppelingen',
  subtitle: 'Koppel je bank en nieuwe transacties komen vanzelf binnen, klaar om af te letteren.',
  connectBank: 'Bank koppelen',
  connectAnotherBank: 'Nog een bank koppelen',
  connectBankFeed: 'Bankkoppeling maken',
  connecting: 'Koppelen…',
  allFeeds: 'Alle bankkoppelingen',

  list: {
    loadError: 'Je bankkoppelingen konden niet worden geladen.',
    retry: 'Opnieuw proberen',
    emptyTitle: 'Nog geen bank gekoppeld',
    emptyDescription:
      'Koppel je bank om transacties automatisch te importeren. Bankafschriften importeren blijft naast een bankkoppeling gewoon werken.',
    noProviders: 'Bankkoppelingen zijn nog niet beschikbaar voor {country}. Je kunt wel bankafschriften importeren.',
    providersLoadError: 'De beschikbare koppelopties konden niet worden geladen.',
  },

  providers: {
    plaid: 'Plaid',
    stripe_fc: 'Stripe',
    ponto: 'Ponto',
    enable_banking: 'Enable Banking',
    teller: 'Teller',
  },

  status: {
    active: 'Gekoppeld',
    reauth_required: 'Opnieuw koppelen nodig',
    expiring: 'Verloopt binnenkort',
    revoked: 'Toegang ingetrokken',
    disconnected: 'Ontkoppeld',
    error: 'Synchronisatiefout',
  },

  connection: {
    via: 'via {provider}',
    unknownBank: 'Bankkoppeling',
    lastSynced: 'Laatst gesynchroniseerd {time}',
    neverSynced: 'Nog niet gesynchroniseerd',
    accessEnds: 'Toegang tot de bank eindigt {date}',
    accountsHeading: 'Rekeningen',
    linkedTo: 'Gekoppeld aan {name}',
    notLinked: 'Niet gekoppeld',
    importsFrom: 'Importeert vanaf {date}',
    importsAll: 'Importeert alle beschikbare historie',
    accountTypes: {
      depository: 'Bankrekening',
      credit: 'Creditcard',
      loan: 'Lening',
    },
    unlinkedNote: {
      one: '{count} rekening is niet gekoppeld aan een WeldBooks-bankrekening, dus de transacties worden niet geïmporteerd.',
      other: '{count} rekeningen zijn niet gekoppeld aan een WeldBooks-bankrekening, dus de transacties worden niet geïmporteerd.',
    },
  },

  banners: {
    reauthTitle: 'Log opnieuw in bij je bank',
    reauthBody:
      '{bank} vraagt je opnieuw in te loggen voordat nieuwe transacties kunnen worden geïmporteerd. Wat al is geïmporteerd blijft ongewijzigd.',
    expiringTitle: 'Toegang tot de bank eindigt binnenkort',
    expiringToday: 'De toegang tot {bank} eindigt vandaag. Verleng de toegang zodat transacties blijven binnenkomen.',
    expiringBody: {
      one: 'De toegang tot {bank} eindigt over {count} dag. Verleng de toegang zodat transacties blijven binnenkomen.',
      other: 'De toegang tot {bank} eindigt over {count} dagen. Verleng de toegang zodat transacties blijven binnenkomen.',
    },
    revokedTitle: 'Toegang is ingetrokken',
    revokedBody:
      'De toegang tot {bank} is bij de bank ingetrokken. Koppel opnieuw om verder te gaan. Je bankrekeningen en hun transacties blijven zoals ze zijn.',
    disconnectedTitle: 'Ontkoppeld',
    disconnectedBody:
      'Importeren is uitgeschakeld voor {bank}. Koppel opnieuw om verder te gaan. Je bankrekeningen en hun transacties blijven zoals ze zijn.',
    errorTitle: 'De laatste synchronisatie is mislukt',
    errorBody:
      'De bankkoppeling meldde een probleem. Probeer zo opnieuw te synchroniseren, of koppel opnieuw als het blijft gebeuren.',
    errorDetail: 'Gemeld: {error}',
  },

  actions: {
    syncNow: 'Nu synchroniseren',
    syncing: 'Synchroniseren…',
    refreshAndSync: 'Vraag de bank om verse gegevens',
    reconnect: 'Opnieuw koppelen',
    renew: 'Toegang verlengen',
    connectAgain: 'Opnieuw koppelen',
    addAccounts: 'Rekeningen toevoegen',
    linkAccounts: 'Rekeningen koppelen',
    pendingTransactions: 'Lopende transacties',
    hidePending: 'Lopende transacties verbergen',
    disconnect: 'Ontkoppelen',
    remove: 'Koppeling verwijderen',
    moreActions: 'Meer acties',
    warnings: 'Meldingen van recente synchronisaties',
  },

  sync: {
    done: 'Synchronisatie klaar: {added} nieuw, {updated} bijgewerkt, {removed} verwijderd.',
    upToDate: 'Alles is al up-to-date.',
    matched: '{count} automatisch afgeletterd.',
    inProgress: 'Er loopt al een synchronisatie voor deze koppeling.',
    notActive: 'Koppel deze bank opnieuw voordat je kunt synchroniseren.',
    noAccounts: 'Koppel minstens één rekening voordat je synchroniseert.',
    notFound: 'Deze bankkoppeling bestaat niet meer.',
    failed: 'De synchronisatie is mislukt: {error}',
  },

  pending: {
    description:
      'De bank heeft deze gemeld maar nog niet geboekt. Ze worden afgeletterd zodra de bank ze boekt.',
    empty: 'Geen lopende transacties.',
    loadError: 'Lopende transacties konden niet worden geladen.',
    count: {
      one: '{count} lopende transactie',
      other: '{count} lopende transacties',
    },
    columns: {
      date: 'Datum',
      description: 'Omschrijving',
      amount: 'Bedrag',
    },
    noDescription: 'Geen omschrijving',
  },

  warnings: {
    description: 'Dingen die de synchronisatie heeft opgemerkt en afgehandeld; je hoeft niets te doen tenzij dat er staat.',
  },

  disconnect: {
    title: '{bank} ontkoppelen?',
    description:
      'WeldBooks stopt met importeren en trekt de toegang bij de bank in. Alles wat al is geïmporteerd blijft op je bankrekeningen en in je boekhouding staan, en je kunt later opnieuw koppelen.',
    confirm: 'Ontkoppelen',
    done: '{bank} is ontkoppeld.',
  },

  remove: {
    title: '{bank} verwijderen?',
    description:
      'WeldBooks trekt de toegang bij de bank in en verwijdert deze koppeling. Alles wat al is geïmporteerd blijft op je bankrekeningen en in je boekhouding staan, en die rekeningen kunnen opnieuw aan een bankkoppeling worden gekoppeld.',
    confirm: 'Koppeling verwijderen',
    done: '{bank} is verwijderd.',
  },

  connect: {
    title: 'Koppel je bank',
    description: 'Kies hoe WeldBooks met je bank verbinding maakt.',
    providerLabel: 'Koppelen met',
    providerHistory: 'Tot {days} dagen historie',
    institutionLabel: 'Je bank',
    institutionSearch: 'Zoek je bank',
    institutionList: 'Gevonden banken',
    institutionLoading: 'Banken laden…',
    institutionEmpty: 'Geen bank gevonden voor "{query}".',
    institutionError: 'De lijst met banken kon niet worden geladen.',
    accountHolderLabel: 'Te koppelen rekeningen',
    business: 'Zakelijke rekeningen',
    personal: 'Privérekeningen',
    redirectNote: 'Je wordt doorgestuurd naar je bank om in te loggen en toegang goed te keuren, en daarna weer hier teruggebracht.',
    continue: 'Doorgaan',
    cancel: 'Annuleren',
    connected: '{bank} is gekoppeld.',
    reconnected: '{bank} is opnieuw gekoppeld.',
    accountsAdded: 'Rekeningen bijgewerkt voor {bank}.',
    syncStarted: 'Eerste synchronisatie gestart. Nieuwe transacties verschijnen zo.',
  },

  mapping: {
    title: 'Koppel je rekeningen bij {bank}',
    description:
      'Koppel elke rekening aan een bankrekening in WeldBooks, maak een nieuwe aan of sla de rekening over. Overgeslagen rekeningen kun je later koppelen.',
    historyTitle: 'Hoe ver transacties teruggaan',
    historyBody:
      '{provider} levert tot {days} dagen transactiehistorie, gerekend vanaf vandaag. Oudere transacties moeten uit een afschriftimport komen.',
    actionLabel: 'Wat te doen',
    actionLink: 'Koppelen aan een bestaande bankrekening',
    actionCreate: 'Een nieuwe bankrekening aanmaken',
    actionSkip: 'Deze rekening niet importeren',
    bankAccountLabel: 'WeldBooks-bankrekening',
    selectBankAccount: 'Kies een bankrekening',
    noBankAccounts: 'Er is geen bankrekening beschikbaar om aan te koppelen. Maak een nieuwe aan.',
    bankAccountsError: 'Je bankrekeningen konden niet worden geladen. Je kunt wel nieuwe aanmaken.',
    bankAccountsLoading: 'Je bankrekeningen laden…',
    suggested: {
      fingerprint: 'Dezelfde rekening als eerder',
      iban: 'IBAN komt overeen',
      last4: 'Laatste vier cijfers komen overeen',
      name: 'Dezelfde naam',
    },
    newNameLabel: 'Naam van de nieuwe bankrekening',
    newTypeLabel: 'Rekeningtype',
    accountTypes: {
      checking: 'Betaalrekening',
      savings: 'Spaarrekening',
      credit_card: 'Creditcard',
      money_market: 'Geldmarktrekening',
      line_of_credit: 'Kredietlijn',
    },
    syncFromLabel: 'Transacties importeren vanaf',
    syncFromHint: 'Laat leeg om alles te importeren wat {provider} kan leveren, tot {days} dagen.',
    syncFromHintNoLimit: 'Laat leeg om alles te importeren wat de bank kan leveren.',
    syncFromImported:
      'De laatste afschriftimport op deze rekening was op {date}. Transacties vóór de datum die je instelt worden overgeslagen, zodat geïmporteerde afschriften niet dubbel meetellen.',
    currencyMismatch: 'Deze rekening staat in {feed}, maar de bankrekening in {bank}.',
    startSync: 'Meteen de eerste synchronisatie starten',
    submit: {
      one: '{count} rekening koppelen',
      other: '{count} rekeningen koppelen',
    },
    later: 'Later koppelen',
    linking: 'Koppelen…',
    problems: {
      bank_account_required: 'Kies een bankrekening.',
      bank_account_twice: 'Deze bankrekening wordt hierboven al voor een andere rekening gebruikt.',
      name_required: 'Vul een naam in voor de nieuwe bankrekening.',
    },
    nothingToLink: 'Kies minstens één rekening om te koppelen of aan te maken.',
    done: {
      one: '{count} rekening gekoppeld.',
      other: '{count} rekeningen gekoppeld.',
    },
    allLinked: 'Alle rekeningen van deze koppeling zijn gekoppeld.',
  },

  callback: {
    title: 'Je bank koppelen',
    processing: 'De koppeling met je bank wordt afgerond…',
    backToFeeds: 'Terug naar bankkoppelingen',
    errors: {
      noPending: 'De bankkoppeling die je was gestart is niet gevonden. Begin opnieuw bij Bankkoppelingen.',
      missingCode: 'Je bank heeft geen autorisatiecode teruggestuurd.',
      deniedWithReason: 'Je bank heeft de koppeling niet goedgekeurd: {reason}',
      stateMismatch:
        'Het antwoord van je bank hoort niet bij de koppeling die je was gestart. Begin opnieuw bij Bankkoppelingen.',
      missingOAuthState: 'Je bank is niet teruggekeerd naar de koppeling die je was gestart. Begin opnieuw bij Bankkoppelingen.',
    },
  },

  account: {
    noFeedTitle: 'Geen bankkoppeling op deze rekening',
    noFeedDescription: 'Koppel je bank om de transacties van deze rekening automatisch te importeren.',
    connectFeed: 'Bankkoppeling maken',
    manageFeed: 'Bankkoppeling beheren',
    feedStatusLabel: 'Bankkoppeling',
    connectedThrough: 'Gekoppeld via {bank}',
  },

  /** De compacte samenvatting boven de lijst met bankrekeningen. */
  strip: {
    label: 'Bankkoppelingen',
    connectPrompt: 'Koppel je bank en nieuwe transacties komen vanzelf binnen.',
    connected: {
      one: '{count} bank gekoppeld',
      other: '{count} banken gekoppeld',
    },
    synced: 'bijgewerkt {time}',
    neverSynced: 'nog niet bijgewerkt',
    attention: {
      one: '{count} vraagt aandacht',
      other: '{count} vragen aandacht',
    },
    manage: 'Bankkoppelingen beheren',
  },

  /** De lijst met bankrekeningen als er nog geen zijn en een bankkoppeling mogelijk is. */
  emptyAccounts: {
    description:
      'Koppel je bank om je rekeningen en transacties automatisch binnen te halen, of voeg zelf een rekening toe.',
    addManually: 'Rekening handmatig toevoegen',
  },
  errors: {
    generic: 'Er ging iets mis. Probeer het opnieuw.',
    forbidden: 'Je hebt geen toestemming om dit te doen.',
    notFound: 'Deze bankkoppeling bestaat niet meer.',
    conflictLink: 'Deze bankkoppeling hoort al bij een andere boekhoudentiteit.',
    conflictMap:
      'Een van deze bankrekeningen is al gekoppeld aan een andere bankkoppeling. Kies een andere bankrekening, of ontkoppel eerst de andere koppeling.',
    providerFailed: 'De aanbieder van de bankgegevens kon het verzoek niet afronden. Probeer het over een paar minuten opnieuw.',
    unavailable: 'Deze aanbieder van bankkoppelingen is nog niet ingesteld. Neem contact op met support als dit blijft gebeuren.',
    badRequest: 'De aanbieder van de bankkoppeling heeft het verzoek niet geaccepteerd.',
    scriptFailed:
      'Het koppelvenster van de bank kon niet worden geladen. Controleer je verbinding of adblocker en probeer het opnieuw.',
    incompleteSession: 'De bankkoppeling kon niet worden gestart. Probeer het opnieuw.',
    insecureUrl: 'De bank stuurde een link die niet veilig is, dus de koppeling is gestopt.',
    stripeNotConfigured: 'Stripe-bankkoppelingen zijn in deze omgeving niet ingesteld.',
    providerWindow: 'Het koppelvenster van de bank meldde een probleem.',
    detail: 'Gemeld: {detail}',
  },
};
