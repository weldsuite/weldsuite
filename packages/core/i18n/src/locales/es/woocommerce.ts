export const woocommerce = {
    title: 'Integración con WooCommerce',
    description: 'Conecta y sincroniza tus tiendas de WooCommerce',

    dashboard: {
      title: 'Panel',
      woocommerceDashboard: 'Panel de WooCommerce',
      overview: 'Resumen de la Tienda',
      connections: 'Conexiones',
      totalConnections: 'Total de Conexiones',
      activeStores: 'Tiendas Activas',
      syncedProducts: 'Productos Sincronizados',
      syncedOrders: 'Pedidos Sincronizados',
      syncedCustomers: 'Clientes Sincronizados',
      lastSync: 'Última Sincronización',
      connectionHealth: 'Estado de la Conexión',
      recentActivity: 'Actividad Reciente',
      storePerformance: 'Rendimiento de la Tienda',
      noConnections: 'No hay conexiones de WooCommerce',
      addConnection: 'Añade tu primera tienda de WooCommerce para comenzar',
      welcomeTitle: 'Conecta tu Tienda de WooCommerce',
      welcomeDescription: 'Sincroniza productos, pedidos y clientes de tus tiendas de WooCommerce',
    },

    connections: {
      title: 'Conexiones',
      connection: 'Conexión',
      newConnection: 'Nueva Conexión',
      editConnection: 'Editar Conexión',
      deleteConnection: 'Eliminar Conexión',
      testConnection: 'Probar Conexión',
      connectionDetails: 'Detalles de la Conexión',
      storeDetails: 'Detalles de la Tienda',
      syncSettings: 'Configuración de Sincronización',

      // Form fields
      name: 'Nombre de la Conexión',
      namePlaceholder: 'Mi Tienda WooCommerce',
      storeUrl: 'URL de la Tienda',
      storeUrlPlaceholder: 'https://yourstore.com',
      consumerKey: 'Clave del Consumidor',
      consumerKeyPlaceholder: 'ck_...',
      consumerSecret: 'Secreto del Consumidor',
      consumerSecretPlaceholder: 'cs_...',

      // Sync options
      syncProducts: 'Sincronizar Productos',
      syncOrders: 'Sincronizar Pedidos',
      syncCustomers: 'Sincronizar Clientes',

      // Status
      status: {
        active: 'Activo',
        inactive: 'Inactivo',
        error: 'Error',
        testing: 'Probando',
      },

      // Actions
      actions: {
        create: 'Crear Conexión',
        update: 'Actualizar Conexión',
        delete: 'Eliminar Conexión',
        test: 'Probar Conexión',
        sync: 'Sincronizar Ahora',
        viewLogs: 'Ver Registros',
      },

      // Messages
      messages: {
        connectionCreated: 'Conexión creada correctamente',
        connectionUpdated: 'Conexión actualizada correctamente',
        connectionDeleted: 'Conexión eliminada correctamente',
        testSuccess: 'Prueba de conexión exitosa',
        testFailed: 'Prueba de conexión fallida',
        syncStarted: 'Sincronización iniciada',
        syncCompleted: 'Sincronización completada correctamente',
        syncFailed: 'No se pudo sincronizar',
      },

      // Validation
      validation: {
        nameRequired: 'El nombre de la conexión es obligatorio',
        storeUrlRequired: 'La URL de la tienda es obligatoria',
        storeUrlInvalid: 'La URL de la tienda debe ser una URL válida',
        consumerKeyRequired: 'La clave del consumidor es obligatoria',
        consumerSecretRequired: 'El secreto del consumidor es obligatorio',
      },
    },

    products: {
      title: 'Productos',
      product: 'Producto',
      productsFromConnection: 'Productos de {name}',
      allConnections: 'Todas las Conexiones',
      selectConnection: 'Seleccionar Conexión',
      productName: 'Nombre del Producto',
      sku: 'SKU',
      price: 'Precio',
      stock: 'Stock',
      stockQuantity: 'Cantidad en Stock',
      inStock: 'En Stock',
      outOfStock: 'Sin Stock',
      category: 'Categoría',
      lastSynced: 'Última Sincronización',

      actions: {
        sync: 'Sincronizar Productos',
        viewDetails: 'Ver Detalles',
        syncAll: 'Sincronizar Todos los Productos',
      },

      messages: {
        syncStarted: 'Sincronización de productos iniciada',
        syncCompleted: '{count} productos sincronizados correctamente',
        syncFailed: 'No se pudieron sincronizar los productos',
      },
    },

    orders: {
      title: 'Pedidos',
      order: 'Pedido',
      ordersFromConnection: 'Pedidos de {name}',
      orderNumber: 'Número de Pedido',
      customer: 'Cliente',
      total: 'Total',
      status: 'Estado',
      date: 'Fecha',
      items: 'Artículos',
      lastSynced: 'Última Sincronización',

      statuses: {
        pending: 'Pendiente',
        processing: 'Procesando',
        onHold: 'En Espera',
        completed: 'Completado',
        cancelled: 'Cancelado',
        refunded: 'Reembolsado',
        failed: 'Fallido',
      },

      actions: {
        sync: 'Sincronizar Pedidos',
        viewDetails: 'Ver Detalles',
        syncAll: 'Sincronizar Todos los Pedidos',
      },

      messages: {
        syncStarted: 'Sincronización de pedidos iniciada',
        syncCompleted: '{count} pedidos sincronizados correctamente',
        syncFailed: 'No se pudieron sincronizar los pedidos',
      },
    },

    customers: {
      title: 'Clientes',
      customer: 'Cliente',
      customersFromConnection: 'Clientes de {name}',
      customerName: 'Nombre del Cliente',
      email: 'Correo Electrónico',
      phone: 'Teléfono',
      ordersCount: 'Pedidos',
      totalSpent: 'Total Gastado',
      lastOrder: 'Último Pedido',
      lastSynced: 'Última Sincronización',

      actions: {
        sync: 'Sincronizar Clientes',
        viewDetails: 'Ver Detalles',
        syncAll: 'Sincronizar Todos los Clientes',
      },

      messages: {
        syncStarted: 'Sincronización de clientes iniciada',
        syncCompleted: '{count} clientes sincronizados correctamente',
        syncFailed: 'No se pudieron sincronizar los clientes',
      },
    },

    logs: {
      title: 'Registros de Sincronización',
      log: 'Registro',
      timestamp: 'Marca de Tiempo',
      action: 'Acción',
      connection: 'Conexión',
      status: 'Estado',
      details: 'Detalles',
      allConnections: 'Todas las Conexiones',
      filterByConnection: 'Filtrar por conexión',

      statuses: {
        success: 'Exitoso',
        error: 'Error',
        warning: 'Advertencia',
        info: 'Información',
      },

      actions: {
        refresh: 'Actualizar Registros',
        clearLogs: 'Limpiar Registros',
        exportLogs: 'Exportar Registros',
      },
    },
  };
