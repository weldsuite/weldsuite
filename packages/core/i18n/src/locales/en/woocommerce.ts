export const woocommerce = {
    title: 'WooCommerce Integration',
    description: 'Connect and sync your WooCommerce stores',

    dashboard: {
      title: 'Dashboard',
      woocommerceDashboard: 'WooCommerce Dashboard',
      overview: 'Store Overview',
      connections: 'Connections',
      totalConnections: 'Total Connections',
      activeStores: 'Active Stores',
      syncedProducts: 'Synced Products',
      syncedOrders: 'Synced Orders',
      syncedCustomers: 'Synced Customers',
      lastSync: 'Last Sync',
      connectionHealth: 'Connection Health',
      recentActivity: 'Recent Activity',
      storePerformance: 'Store Performance',
      noConnections: 'No WooCommerce connections',
      addConnection: 'Add your first WooCommerce store to get started',
      welcomeTitle: 'Connect Your WooCommerce Store',
      welcomeDescription: 'Sync products, orders, and customers from your WooCommerce stores',
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

      // Form fields
      name: 'Connection Name',
      namePlaceholder: 'My WooCommerce Store',
      storeUrl: 'Store URL',
      storeUrlPlaceholder: 'https://yourstore.com',
      consumerKey: 'Consumer Key',
      consumerKeyPlaceholder: 'ck_...',
      consumerSecret: 'Consumer Secret',
      consumerSecretPlaceholder: 'cs_...',

      // Sync options
      syncProducts: 'Sync Products',
      syncOrders: 'Sync Orders',
      syncCustomers: 'Sync Customers',

      // Status
      status: {
        active: 'Active',
        inactive: 'Inactive',
        error: 'Error',
        testing: 'Testing',
      },

      // Actions
      actions: {
        create: 'Create Connection',
        update: 'Update Connection',
        delete: 'Delete Connection',
        test: 'Test Connection',
        sync: 'Sync Now',
        viewLogs: 'View Logs',
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
      },

      // Validation
      validation: {
        nameRequired: 'Connection name is required',
        storeUrlRequired: 'Store URL is required',
        storeUrlInvalid: 'Store URL must be a valid URL',
        consumerKeyRequired: 'Consumer key is required',
        consumerSecretRequired: 'Consumer secret is required',
      },
    },

    products: {
      title: 'Products',
      product: 'Product',
      productsFromConnection: 'Products from {name}',
      allConnections: 'All Connections',
      selectConnection: 'Select Connection',
      productName: 'Product Name',
      sku: 'SKU',
      price: 'Price',
      stock: 'Stock',
      stockQuantity: 'Stock Quantity',
      inStock: 'In Stock',
      outOfStock: 'Out of Stock',
      category: 'Category',
      lastSynced: 'Last Synced',

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

    orders: {
      title: 'Orders',
      order: 'Order',
      ordersFromConnection: 'Orders from {name}',
      orderNumber: 'Order Number',
      customer: 'Customer',
      total: 'Total',
      status: 'Status',
      date: 'Date',
      items: 'Items',
      lastSynced: 'Last Synced',

      statuses: {
        pending: 'Pending',
        processing: 'Processing',
        onHold: 'On Hold',
        completed: 'Completed',
        cancelled: 'Cancelled',
        refunded: 'Refunded',
        failed: 'Failed',
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
      lastSynced: 'Last Synced',

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
