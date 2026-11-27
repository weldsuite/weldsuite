/**
 * WeldBooks "verbonden boekhouden" (fase 1): de pagina Te verwerken en haar
 * soorten, de lijstweergaven waar de snelkoppelingen van de eigenaar naartoe
 * gaan, de ene lijst Contacten, de melding op het overzicht en de commando's in
 * het palet. Meervouden zijn `{ one, other }` met een plaatsaanduiding
 * `{count}`. Bereikbaar als `t.weldbooksConnected`.
 */
export const weldbooksConnected = {
  todo: {
    title: 'Te verwerken',
    description: 'Alles in je boekhouding waar een persoon naar moet kijken, het dringendste eerst.',
    loadFailed: 'Je lijst met te verwerken items kon niet worden geladen.',
    emptyTitle: 'Alles is bijgewerkt',
    emptyDescription: 'Er hoeft nu niets te gebeuren. Nieuwe items verschijnen hier zodra ze binnenkomen.',
    showAll: 'Toon alle {count}',
    showFewer: 'Toon minder',
    loadMore: 'Meer laden',
    loadingMore: 'Laden…',
    listFailed: 'Deze items konden niet worden geladen.',
    mixedCurrency: 'Gemengde valuta, getoond in {currency}',
    dueOn: 'Vervalt {date}',
    kinds: {
      vat_return: {
        title: 'Aangifte om in te dienen',
        action: 'Aangifte openen',
      },
      bank_feeds: {
        title: 'Bankkoppelingen',
        action: 'Bankkoppelingen bekijken',
      },
      invoices_overdue: {
        title: 'Achterstallige facturen',
        action: 'Achterstallige facturen bekijken',
      },
      bills_due: {
        title: 'Te betalen inkoopfacturen',
        action: 'Te betalen inkoopfacturen bekijken',
      },
      bills_to_approve: {
        title: 'Inkoopfacturen om goed te keuren',
        action: 'Goed te keuren inkoopfacturen bekijken',
      },
      documents: {
        title: 'Inbox',
        action: { one: '1 document controleren', other: '{count} documenten controleren' },
      },
      duplicates: {
        title: 'Mogelijke dubbelen',
        action: 'Dubbelen bekijken',
      },
      bank_lines: {
        title: 'Bankregels',
        action: { one: '1 regel verwerken', other: '{count} regels verwerken' },
      },
      unapplied_credit: {
        title: 'Niet toegepast tegoed',
        action: 'Niet toegepast tegoed bekijken',
      },
    },
    hints: {
      possible_match: 'Mogelijke match gevonden',
      possible_duplicate: 'Mogelijk dubbel',
      ocr_failed: 'Scannen mislukt, controleer handmatig',
      awaiting_approval: 'Wacht op goedkeuring',
      overdue: 'Achterstallig',
      overdue_partial: 'Achterstallig, deels betaald',
      due_soon: 'Binnenkort te betalen',
      not_filed: 'Nog niet ingediend',
      rejected: 'Afgewezen',
      connection_error: 'Verbindingsfout',
      reauth_required: 'Opnieuw koppelen nodig',
      consent_expiring: 'Toestemming verloopt binnenkort',
      unapplied_credit: 'Niet toegepast tegoed',
    },
    severity: {
      info: 'Ter informatie',
      warning: 'Vraagt binnenkort aandacht',
      danger: 'Vraagt nu aandacht',
    },
  },
  listViews: {
    filterLabel: 'Toon',
    open: 'Openstaand',
    overdue: 'Achterstallig',
    dueSoon: 'Vervalt deze week of achterstallig',
  },
  contacts: {
    searchPlaceholder: 'Zoek contacten...',
    newContact: 'Nieuw contact',
    noContacts: 'Geen contacten gevonden',
    emptyDescription: 'Maak je eerste contact aan om te beginnen',
    filterRoleLabel: 'Toon',
    roleAll: 'Alle',
    roleCustomers: 'Klanten',
    colName: 'Naam',
    colEmail: 'E-mail',
    colRole: 'Rol',
  },
  dashboard: {
    calloutTitle: {
      one: '1 ding om te verwerken',
      other: '{count} dingen om te verwerken',
    },
    calloutDescription: 'Bankregels, documenten, inkoopfacturen en meer wachten op je.',
    calloutAction: 'Naar Te verwerken',
  },
  palette: {
    toProcess: 'Te verwerken',
    toProcessHint: 'Alles wat je aandacht nodig heeft',
    processBankLines: 'Bankregels verwerken',
    processBankLinesHint: 'Boek de regels die op je bankrekeningen wachten',
    keywords: 'te verwerken to process todo inbox aandacht openstaand',
    bankLinesKeywords: 'bankregels verwerken afletteren categoriseren transacties process bank lines reconcile',
  },
  menu: {
    toProcessBadge: '{count} items om te verwerken',
    inboxBadge: '{count} documenten in de inbox',
    bankBadge: '{count} bankregels om te verwerken',
  },
};
