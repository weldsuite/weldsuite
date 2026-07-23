export const shopify = {
    title: 'Shopify Integration',
    description: 'Connect and sync your Shopify stores',

    dashboard: {
      title: 'Dashboard',
      shopifyDashboard: 'Shopify Dashboard',
      overview: 'Store Overview',
      connections: 'Connections',
      totalConnections: 'Total Connections',
      activeStores: 'Active Stores',
      syncedProducts: 'Synced Products',
      syncedCollections: 'Synced Collections',
      syncedOrders: 'Synced Orders',
      syncedCustomers: 'Synced Customers',
      lastSync: 'Last Sync',
      connectionHealth: 'Connection Health',
      recentActivity: 'Recent Activity',
      storePerformance: 'Store Performance',
      noConnections: 'No Shopify connections',
      addConnection: 'Add your first Shopify store to get started',
      welcomeTitle: 'Connect Your Shopify Store',
      welcomeDescription: 'Sync products, collections, orders, and customers from your Shopify stores',
    },

    connections: {
      title: 'Connections',
      connection: 'Connection',
      newConnection: 'New Connection',
      editConnection: 'Edit Connection',
      deleteConnection: 'Delete Connection',
      testConnection: 'Test Connection',
      connectionDetails: 'Connection Details',
      storeDetails: 'Store Details',
      syncSettings: 'Sync Settings',
      oauthSettings: 'OAuth Settings',

      // Form fields
      name: 'Connection Name',
      namePlaceholder: 'My Shopify Store',
      shopDomain: 'Shop Domain',
      shopDomainPlaceholder: 'yourstore.myshopify.com',
      accessToken: 'Access Token',
      scope: 'Scope',

      // Sync options
      syncProducts: 'Sync Products',
      syncCollections: 'Sync Collections',
      syncOrders: 'Sync Orders',
      syncCustomers: 'Sync Customers',
      syncFulfillment: 'Sync Fulfillment',

      // Status
      status: {
        active: 'Active',
        inactive: 'Inactive',
        error: 'Error',
        oauthPending: 'OAuth Pending',
      },

      // Actions
      actions: {
        create: 'Create Connection',
        update: 'Update Connection',
        delete: 'Delete Connection',
        test: 'Test Connection',
        sync: 'Sync Now',
        viewLogs: 'View Logs',
        initiateOAuth: 'Connect with Shopify',
        completeOAuth: 'Complete Authorization',
      },

      // Messages
      messages: {
        connectionCreated: 'Connection created successfully',
        connectionUpdated: 'Connection updated successfully',
        connectionDeleted: 'Connection deleted successfully',
        testSuccess: 'Connection test successful',
        testFailed: 'Connection test failed',
        syncStarted: 'Sync started',
        syncCompleted: 'Sync completed successfully',
        syncFailed: 'Sync failed',
        oauthInitiated: 'Redirecting to Shopify for authorization',
        oauthCompleted: 'Authorization completed successfully',
        oauthFailed: 'Authorization failed',
      },

      // Validation
      validation: {
        nameRequired: 'Connection name is required',
        shopDomainRequired: 'Shop domain is required',
        shopDomainInvalid: 'Shop domain must be a valid myshopify.com domain',
      },
    },

    products: {
      title: 'Products',
      product: 'Product',
      productsFromConnection: 'Products from {name}',
      allConnections: 'All Connections',
      selectConnection: 'Select Connection',
      productName: 'Product Name',
      productType: 'Product Type',
      vendor: 'Vendor',
      sku: 'SKU',
      price: 'Price',
      inventory: 'Inventory',
      status: 'Status',
      lastSynced: 'Last Synced',

      statuses: {
        active: 'Active',
        draft: 'Draft',
        archived: 'Archived',
      },

      actions: {
        sync: 'Sync Products',
        viewDetails: 'View Details',
        syncAll: 'Sync All Products',
      },

      messages: {
        syncStarted: 'Product sync started',
        syncCompleted: '{count} products synced successfully',
        syncFailed: 'Failed to sync products',
      },
    },

    collections: {
      title: 'Collections',
      collection: 'Collection',
      collectionsFromConnection: 'Collections from {name}',
      collectionName: 'Collection Name',
      productsCount: 'Products',
      type: 'Type',
      lastSynced: 'Last Synced',

      types: {
        manual: 'Manual',
        smart: 'Smart',
        custom: 'Custom',
      },

      actions: {
        sync: 'Sync Collections',
        viewDetails: 'View Details',
        syncAll: 'Sync All Collections',
      },

      messages: {
        syncStarted: 'Collection sync started',
        syncCompleted: '{count} collections synced successfully',
        syncFailed: 'Failed to sync collections',
      },
    },

    variants: {
      title: 'Variants',
      variant: 'Variant',
      variantsFromConnection: 'Variants from {name}',
      variantName: 'Variant Name',
      product: 'Product',
      sku: 'SKU',
      price: 'Price',
      inventory: 'Inventory',
      option1: 'Option 1',
      option2: 'Option 2',
      option3: 'Option 3',
      lastSynced: 'Last Synced',

      actions: {
        sync: 'Sync Variants',
        viewDetails: 'View Details',
        syncAll: 'Sync All Variants',
      },

      messages: {
        syncStarted: 'Variant sync started',
        syncCompleted: '{count} variants synced successfully',
        syncFailed: 'Failed to sync variants',
      },
    },

    orders: {
      title: 'Orders',
      order: 'Order',
      ordersFromConnection: 'Orders from {name}',
      orderNumber: 'Order Number',
      customer: 'Customer',
      total: 'Total',
      status: 'Status',
      financialStatus: 'Financial Status',
      fulfillmentStatus: 'Fulfillment Status',
      date: 'Date',
      items: 'Items',
      lastSynced: 'Last Synced',

      statuses: {
        open: 'Open',
        archived: 'Archived',
        cancelled: 'Cancelled',
      },

      financialStatuses: {
        pending: 'Pending',
        authorized: 'Authorized',
        partiallyPaid: 'Partially Paid',
        paid: 'Paid',
        partiallyRefunded: 'Partially Refunded',
        refunded: 'Refunded',
        voided: 'Voided',
      },

      fulfillmentStatuses: {
        fulfilled: 'Fulfilled',
        partial: 'Partial',
        unfulfilled: 'Unfulfilled',
        restocked: 'Restocked',
      },

      actions: {
        sync: 'Sync Orders',
        viewDetails: 'View Details',
        syncAll: 'Sync All Orders',
      },

      messages: {
        syncStarted: 'Order sync started',
        syncCompleted: '{count} orders synced successfully',
        syncFailed: 'Failed to sync orders',
      },
    },

    customers: {
      title: 'Customers',
      customer: 'Customer',
      customersFromConnection: 'Customers from {name}',
      customerName: 'Customer Name',
      email: 'Email',
      phone: 'Phone',
      ordersCount: 'Orders',
      totalSpent: 'Total Spent',
      lastOrder: 'Last Order',
      state: 'State',
      lastSynced: 'Last Synced',

      states: {
        disabled: 'Disabled',
        invited: 'Invited',
        enabled: 'Enabled',
        declined: 'Declined',
      },

      actions: {
        sync: 'Sync Customers',
        viewDetails: 'View Details',
        syncAll: 'Sync All Customers',
      },

      messages: {
        syncStarted: 'Customer sync started',
        syncCompleted: '{count} customers synced successfully',
        syncFailed: 'Failed to sync customers',
      },
    },

    fulfillments: {
      title: 'Fulfillments',
      fulfillment: 'Fulfillment',
      fulfillmentsFromConnection: 'Fulfillments from {name}',
      order: 'Order',
      trackingNumber: 'Tracking Number',
      trackingCompany: 'Tracking Company',
      status: 'Status',
      shipmentDate: 'Shipment Date',
      lastSynced: 'Last Synced',

      statuses: {
        pending: 'Pending',
        open: 'Open',
        success: 'Success',
        cancelled: 'Cancelled',
        error: 'Error',
        failure: 'Failure',
      },

      actions: {
        sync: 'Sync Fulfillments',
        viewDetails: 'View Details',
        syncAll: 'Sync All Fulfillments',
      },

      messages: {
        syncStarted: 'Fulfillment sync started',
        syncCompleted: '{count} fulfillments synced successfully',
        syncFailed: 'Failed to sync fulfillments',
      },
    },

    logs: {
      title: 'Sync Logs',
      log: 'Log',
      timestamp: 'Timestamp',
      action: 'Action',
      connection: 'Connection',
      status: 'Status',
      details: 'Details',
      allConnections: 'All Connections',
      filterByConnection: 'Filter by connection',

      statuses: {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        info: 'Info',
      },

      actions: {
        refresh: 'Refresh Logs',
        clearLogs: 'Clear Logs',
        exportLogs: 'Export Logs',
      },
    },
  };
