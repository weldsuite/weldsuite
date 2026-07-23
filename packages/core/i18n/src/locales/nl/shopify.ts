export const shopify = {
    title: 'Shopify Integratie',
    description: 'Verbind en synchroniseer uw Shopify winkels',

    dashboard: {
      title: 'Dashboard',
      shopifyDashboard: 'Shopify Dashboard',
      overview: 'Winkeloverzicht',
      connections: 'Verbindingen',
      totalConnections: 'Totaal Verbindingen',
      activeStores: 'Actieve Winkels',
      syncedProducts: 'Gesynchroniseerde Producten',
      syncedCollections: 'Gesynchroniseerde Collecties',
      syncedOrders: 'Gesynchroniseerde Bestellingen',
      syncedCustomers: 'Gesynchroniseerde Klanten',
      lastSync: 'Laatste Synchronisatie',
      connectionHealth: 'Verbindingsstatus',
      recentActivity: 'Recente Activiteit',
      storePerformance: 'Winkelprestaties',
      noConnections: 'Geen Shopify verbindingen',
      addConnection: 'Voeg uw eerste Shopify winkel toe om te beginnen',
      welcomeTitle: 'Verbind Uw Shopify Winkel',
      welcomeDescription: 'Synchroniseer producten, collecties, bestellingen en klanten van uw Shopify winkels',
    },

    connections: {
      title: 'Verbindingen',
      connection: 'Verbinding',
      newConnection: 'Nieuwe Verbinding',
      editConnection: 'Verbinding Bewerken',
      deleteConnection: 'Verbinding Verwijderen',
      testConnection: 'Verbinding Testen',
      connectionDetails: 'Verbindingsdetails',
      storeDetails: 'Winkeldetails',
      syncSettings: 'Synchronisatie-instellingen',
      oauthSettings: 'OAuth Instellingen',

      // Form fields
      name: 'Verbindingsnaam',
      namePlaceholder: 'Mijn Shopify Winkel',
      shopDomain: 'Winkel Domein',
      shopDomainPlaceholder: 'uwwinkel.myshopify.com',
      accessToken: 'Toegangstoken',
      scope: 'Bereik',

      // Sync options
      syncProducts: 'Synchroniseer Producten',
      syncCollections: 'Synchroniseer Collecties',
      syncOrders: 'Synchroniseer Bestellingen',
      syncCustomers: 'Synchroniseer Klanten',
      syncFulfillment: 'Synchroniseer Verzending',

      // Status
      status: {
        active: 'Actief',
        inactive: 'Inactief',
        error: 'Fout',
        oauthPending: 'OAuth In Behandeling',
      },

      // Actions
      actions: {
        create: 'Verbinding Aanmaken',
        update: 'Verbinding Bijwerken',
        delete: 'Verbinding Verwijderen',
        test: 'Verbinding Testen',
        sync: 'Nu Synchroniseren',
        viewLogs: 'Logboeken Bekijken',
        initiateOAuth: 'Verbinden met Shopify',
        completeOAuth: 'Autorisatie Voltooien',
      },

      // Messages
      messages: {
        connectionCreated: 'Verbinding succesvol aangemaakt',
        connectionUpdated: 'Verbinding succesvol bijgewerkt',
        connectionDeleted: 'Verbinding succesvol verwijderd',
        testSuccess: 'Verbindingstest succesvol',
        testFailed: 'Verbindingstest mislukt',
        syncStarted: 'Synchronisatie gestart',
        syncCompleted: 'Synchronisatie succesvol voltooid',
        syncFailed: 'Synchronisatie mislukt',
        oauthInitiated: 'Doorverwijzen naar Shopify voor autorisatie',
        oauthCompleted: 'Autorisatie succesvol voltooid',
        oauthFailed: 'Autorisatie mislukt',
      },

      // Validation
      validation: {
        nameRequired: 'Verbindingsnaam is verplicht',
        shopDomainRequired: 'Winkel domein is verplicht',
        shopDomainInvalid: 'Winkel domein moet een geldig myshopify.com domein zijn',
      },
    },

    products: {
      title: 'Producten',
      product: 'Product',
      productsFromConnection: 'Producten van {name}',
      allConnections: 'Alle Verbindingen',
      selectConnection: 'Selecteer Verbinding',
      productName: 'Productnaam',
      productType: 'Producttype',
      vendor: 'Leverancier',
      sku: 'SKU',
      price: 'Prijs',
      inventory: 'Voorraad',
      status: 'Status',
      lastSynced: 'Laatst Gesynchroniseerd',

      statuses: {
        active: 'Actief',
        draft: 'Concept',
        archived: 'Gearchiveerd',
      },

      actions: {
        sync: 'Producten Synchroniseren',
        viewDetails: 'Details Bekijken',
        syncAll: 'Alle Producten Synchroniseren',
      },

      messages: {
        syncStarted: 'Productsynchronisatie gestart',
        syncCompleted: '{count} producten succesvol gesynchroniseerd',
        syncFailed: 'Producten synchroniseren mislukt',
      },
    },

    collections: {
      title: 'Collecties',
      collection: 'Collectie',
      collectionsFromConnection: 'Collecties van {name}',
      collectionName: 'Collectienaam',
      productsCount: 'Producten',
      type: 'Type',
      lastSynced: 'Laatst Gesynchroniseerd',

      types: {
        manual: 'Handmatig',
        smart: 'Slim',
        custom: 'Aangepast',
      },

      actions: {
        sync: 'Collecties Synchroniseren',
        viewDetails: 'Details Bekijken',
        syncAll: 'Alle Collecties Synchroniseren',
      },

      messages: {
        syncStarted: 'Collectiesynchronisatie gestart',
        syncCompleted: '{count} collecties succesvol gesynchroniseerd',
        syncFailed: 'Collecties synchroniseren mislukt',
      },
    },

    variants: {
      title: 'Varianten',
      variant: 'Variant',
      variantsFromConnection: 'Varianten van {name}',
      variantName: 'Variantnaam',
      product: 'Product',
      sku: 'SKU',
      price: 'Prijs',
      inventory: 'Voorraad',
      option1: 'Optie 1',
      option2: 'Optie 2',
      option3: 'Optie 3',
      lastSynced: 'Laatst Gesynchroniseerd',

      actions: {
        sync: 'Varianten Synchroniseren',
        viewDetails: 'Details Bekijken',
        syncAll: 'Alle Varianten Synchroniseren',
      },

      messages: {
        syncStarted: 'Variantensynchronisatie gestart',
        syncCompleted: '{count} varianten succesvol gesynchroniseerd',
        syncFailed: 'Varianten synchroniseren mislukt',
      },
    },

    orders: {
      title: 'Bestellingen',
      order: 'Bestelling',
      ordersFromConnection: 'Bestellingen van {name}',
      orderNumber: 'Bestelnummer',
      customer: 'Klant',
      total: 'Totaal',
      status: 'Status',
      financialStatus: 'Financiële Status',
      fulfillmentStatus: 'Verzendstatus',
      date: 'Datum',
      items: 'Items',
      lastSynced: 'Laatst Gesynchroniseerd',

      statuses: {
        open: 'Open',
        archived: 'Gearchiveerd',
        cancelled: 'Geannuleerd',
      },

      financialStatuses: {
        pending: 'In Behandeling',
        authorized: 'Geautoriseerd',
        partiallyPaid: 'Gedeeltelijk Betaald',
        paid: 'Betaald',
        partiallyRefunded: 'Gedeeltelijk Terugbetaald',
        refunded: 'Terugbetaald',
        voided: 'Ongeldig',
      },

      fulfillmentStatuses: {
        fulfilled: 'Verzonden',
        partial: 'Gedeeltelijk',
        unfulfilled: 'Niet Verzonden',
        restocked: 'Opnieuw Op Voorraad',
      },

      actions: {
        sync: 'Bestellingen Synchroniseren',
        viewDetails: 'Details Bekijken',
        syncAll: 'Alle Bestellingen Synchroniseren',
      },

      messages: {
        syncStarted: 'Bestellingensynchronisatie gestart',
        syncCompleted: '{count} bestellingen succesvol gesynchroniseerd',
        syncFailed: 'Bestellingen synchroniseren mislukt',
      },
    },

    customers: {
      title: 'Klanten',
      customer: 'Klant',
      customersFromConnection: 'Klanten van {name}',
      customerName: 'Klantnaam',
      email: 'E-mail',
      phone: 'Telefoon',
      ordersCount: 'Bestellingen',
      totalSpent: 'Totaal Uitgegeven',
      lastOrder: 'Laatste Bestelling',
      state: 'Status',
      lastSynced: 'Laatst Gesynchroniseerd',

      states: {
        disabled: 'Uitgeschakeld',
        invited: 'Uitgenodigd',
        enabled: 'Ingeschakeld',
        declined: 'Afgewezen',
      },

      actions: {
        sync: 'Klanten Synchroniseren',
        viewDetails: 'Details Bekijken',
        syncAll: 'Alle Klanten Synchroniseren',
      },

      messages: {
        syncStarted: 'Klantensynchronisatie gestart',
        syncCompleted: '{count} klanten succesvol gesynchroniseerd',
        syncFailed: 'Klanten synchroniseren mislukt',
      },
    },

    fulfillments: {
      title: 'Verzendingen',
      fulfillment: 'Verzending',
      fulfillmentsFromConnection: 'Verzendingen van {name}',
      order: 'Bestelling',
      trackingNumber: 'Trackingnummer',
      trackingCompany: 'Trackingbedrijf',
      status: 'Status',
      shipmentDate: 'Verzenddatum',
      lastSynced: 'Laatst Gesynchroniseerd',

      statuses: {
        pending: 'In Behandeling',
        open: 'Open',
        success: 'Succes',
        cancelled: 'Geannuleerd',
        error: 'Fout',
        failure: 'Mislukt',
      },

      actions: {
        sync: 'Verzendingen Synchroniseren',
        viewDetails: 'Details Bekijken',
        syncAll: 'Alle Verzendingen Synchroniseren',
      },

      messages: {
        syncStarted: 'Verzendingensynchronisatie gestart',
        syncCompleted: '{count} verzendingen succesvol gesynchroniseerd',
        syncFailed: 'Verzendingen synchroniseren mislukt',
      },
    },

    logs: {
      title: 'Synchronisatielogboeken',
      log: 'Logboek',
      timestamp: 'Tijdstempel',
      action: 'Actie',
      connection: 'Verbinding',
      status: 'Status',
      details: 'Details',
      allConnections: 'Alle Verbindingen',
      filterByConnection: 'Filteren op verbinding',

      statuses: {
        success: 'Succes',
        error: 'Fout',
        warning: 'Waarschuwing',
        info: 'Info',
      },

      actions: {
        refresh: 'Logboeken Vernieuwen',
        clearLogs: 'Logboeken Wissen',
        exportLogs: 'Logboeken Exporteren',
      },
    },
  };
