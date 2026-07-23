export const woocommerce = {
    title: 'WooCommerce Integratie',
    description: 'Verbind en synchroniseer uw WooCommerce winkels',

    dashboard: {
      title: 'Dashboard',
      woocommerceDashboard: 'WooCommerce Dashboard',
      overview: 'Winkeloverzicht',
      connections: 'Verbindingen',
      totalConnections: 'Totaal Verbindingen',
      activeStores: 'Actieve Winkels',
      syncedProducts: 'Gesynchroniseerde Producten',
      syncedOrders: 'Gesynchroniseerde Bestellingen',
      syncedCustomers: 'Gesynchroniseerde Klanten',
      lastSync: 'Laatste Synchronisatie',
      connectionHealth: 'Verbindingsstatus',
      recentActivity: 'Recente Activiteit',
      storePerformance: 'Winkelprestaties',
      noConnections: 'Geen WooCommerce verbindingen',
      addConnection: 'Voeg uw eerste WooCommerce winkel toe om te beginnen',
      welcomeTitle: 'Verbind Uw WooCommerce Winkel',
      welcomeDescription: 'Synchroniseer producten, bestellingen en klanten van uw WooCommerce winkels',
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

      // Form fields
      name: 'Verbindingsnaam',
      namePlaceholder: 'Mijn WooCommerce Winkel',
      storeUrl: 'Winkel URL',
      storeUrlPlaceholder: 'https://uwwinkel.nl',
      consumerKey: 'Consumer Key',
      consumerKeyPlaceholder: 'ck_...',
      consumerSecret: 'Consumer Secret',
      consumerSecretPlaceholder: 'cs_...',

      // Sync options
      syncProducts: 'Synchroniseer Producten',
      syncOrders: 'Synchroniseer Bestellingen',
      syncCustomers: 'Synchroniseer Klanten',

      // Status
      status: {
        active: 'Actief',
        inactive: 'Inactief',
        error: 'Fout',
        testing: 'Testen',
      },

      // Actions
      actions: {
        create: 'Verbinding Aanmaken',
        update: 'Verbinding Bijwerken',
        delete: 'Verbinding Verwijderen',
        test: 'Verbinding Testen',
        sync: 'Nu Synchroniseren',
        viewLogs: 'Logboeken Bekijken',
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
      },

      // Validation
      validation: {
        nameRequired: 'Verbindingsnaam is verplicht',
        storeUrlRequired: 'Winkel URL is verplicht',
        storeUrlInvalid: 'Winkel URL moet een geldige URL zijn',
        consumerKeyRequired: 'Consumer key is verplicht',
        consumerSecretRequired: 'Consumer secret is verplicht',
      },
    },

    products: {
      title: 'Producten',
      product: 'Product',
      productsFromConnection: 'Producten van {name}',
      allConnections: 'Alle Verbindingen',
      selectConnection: 'Selecteer Verbinding',
      productName: 'Productnaam',
      sku: 'SKU',
      price: 'Prijs',
      stock: 'Voorraad',
      stockQuantity: 'Voorraad Hoeveelheid',
      inStock: 'Op Voorraad',
      outOfStock: 'Niet Op Voorraad',
      category: 'Categorie',
      lastSynced: 'Laatst Gesynchroniseerd',

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

    orders: {
      title: 'Bestellingen',
      order: 'Bestelling',
      ordersFromConnection: 'Bestellingen van {name}',
      orderNumber: 'Bestelnummer',
      customer: 'Klant',
      total: 'Totaal',
      status: 'Status',
      date: 'Datum',
      items: 'Items',
      lastSynced: 'Laatst Gesynchroniseerd',

      statuses: {
        pending: 'In Behandeling',
        processing: 'Verwerken',
        onHold: 'In Wacht',
        completed: 'Voltooid',
        cancelled: 'Geannuleerd',
        refunded: 'Terugbetaald',
        failed: 'Mislukt',
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
      lastSynced: 'Laatst Gesynchroniseerd',

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
