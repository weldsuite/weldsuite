/**
 * WeldCommerce, opnieuw gebouwd voor de EU-editie (ADR COM-009). Fase 0: de
 * module en het overzicht; producten, categorieën en orders volgen.
 */
export const commerce = {
  appTitle: 'WeldCommerce',
  notInstalled: 'WeldCommerce is niet geïnstalleerd in deze werkruimte.',
  overview: {
    loadFailed: 'Het overzicht kon niet worden geladen.',
    products: 'Producten',
    productsHint: '{active} actief · {draft} concept',
    openOrders: 'Openstaande orders',
    awaitingFulfilment: 'Wacht op verzending',
    unpaid: 'Onbetaald',
    revenueTitle: 'Omzet, laatste 30 dagen',
    revenueDescription: 'Orders uit alle kanalen, zonder geannuleerde en mislukte orders.',
    revenueOrders: '{count} orders',
    revenueEmpty: 'Geen orders in de laatste 30 dagen.',
    recentTitle: 'Recente orders',
    recentEmpty: 'Nog geen orders. Orders uit Shopify en WooCommerce verschijnen hier zodra ze zijn geïmporteerd.',
    columns: {
      order: 'Order',
      customer: 'Klant',
      status: 'Status',
      payment: 'Betaling',
      fulfilment: 'Verzending',
      total: 'Totaal',
      date: 'Datum',
    },
    comingSoon: 'Producten, categorieën en orders komen in de volgende updates van WeldCommerce.',
  },
};
