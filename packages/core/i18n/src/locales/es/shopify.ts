export const shopify = {
    title: 'Integración con Shopify',
    description: 'Conecta y sincroniza tus tiendas de Shopify',

    dashboard: {
      title: 'Panel de control',
      shopifyDashboard: 'Panel de Shopify',
      overview: 'Resumen de la tienda',
      connections: 'Conexiones',
      totalConnections: 'Total de conexiones',
      activeStores: 'Tiendas activas',
      syncedProducts: 'Productos sincronizados',
      syncedCollections: 'Colecciones sincronizadas',
      syncedOrders: 'Pedidos sincronizados',
      syncedCustomers: 'Clientes sincronizados',
      lastSync: 'Última sincronización',
      connectionHealth: 'Estado de la conexión',
      recentActivity: 'Actividad reciente',
      storePerformance: 'Rendimiento de la tienda',
      noConnections: 'No hay conexiones con Shopify',
      addConnection: 'Añade tu primera tienda de Shopify para comenzar',
      welcomeTitle: 'Conecta tu tienda de Shopify',
      welcomeDescription: 'Sincroniza productos, colecciones, pedidos y clientes de tus tiendas de Shopify',
    },

    connections: {
      title: 'Conexiones',
      connection: 'Conexión',
      newConnection: 'Nueva Conexión',
      editConnection: 'Editar Conexión',
      deleteConnection: 'Eliminar Conexión',
      testConnection: 'Probar Conexión',
      connectionDetails: 'Detalles de la conexión',
      storeDetails: 'Detalles de la tienda',
      syncSettings: 'Configuración de sincronización',
      oauthSettings: 'Configuración OAuth',

      // Form fields
      name: 'Nombre de la conexión',
      namePlaceholder: 'Mi tienda de Shopify',
      shopDomain: 'Dominio de la tienda',
      shopDomainPlaceholder: 'mitienda.myshopify.com',
      accessToken: 'Token de acceso',
      scope: 'Alcance',

      // Sync options
      syncProducts: 'Sincronizar Productos',
      syncCollections: 'Sincronizar Colecciones',
      syncOrders: 'Sincronizar Pedidos',
      syncCustomers: 'Sincronizar Clientes',
      syncFulfillment: 'Sincronizar Cumplimiento',

      // Status
      status: {
        active: 'Activo',
        inactive: 'Inactivo',
        error: 'Error',
        oauthPending: 'OAuth pendiente',
      },

      // Actions
      actions: {
        create: 'Crear Conexión',
        update: 'Actualizar Conexión',
        delete: 'Eliminar Conexión',
        test: 'Probar Conexión',
        sync: 'Sincronizar ahora',
        viewLogs: 'Ver registros',
        initiateOAuth: 'Conectar con Shopify',
        completeOAuth: 'Completar autorización',
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
        syncFailed: 'Error en la sincronización',
        oauthInitiated: 'Redirigiendo a Shopify para autorización',
        oauthCompleted: 'Autorización completada correctamente',
        oauthFailed: 'Error en la autorización',
      },

      // Validation
      validation: {
        nameRequired: 'El nombre de la conexión es obligatorio',
        shopDomainRequired: 'El dominio de la tienda es obligatorio',
        shopDomainInvalid: 'El dominio de la tienda debe ser un dominio myshopify.com válido',
      },
    },

    products: {
      title: 'Productos',
      product: 'Producto',
      productsFromConnection: 'Productos de {name}',
      allConnections: 'Todas las conexiones',
      selectConnection: 'Seleccionar Conexión',
      productName: 'Nombre del producto',
      productType: 'Tipo de producto',
      vendor: 'Proveedor',
      sku: 'SKU',
      price: 'Precio',
      inventory: 'Inventario',
      status: 'Estado',
      lastSynced: 'Última sincronización',

      statuses: {
        active: 'Activo',
        draft: 'Borrador',
        archived: 'Archivado',
      },

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

    collections: {
      title: 'Colecciones',
      collection: 'Colección',
      collectionsFromConnection: 'Colecciones de {name}',
      collectionName: 'Nombre de la colección',
      productsCount: 'Productos',
      type: 'Tipo',
      lastSynced: 'Última sincronización',

      types: {
        manual: 'Manual',
        smart: 'Inteligente',
        custom: 'Personalizado',
      },

      actions: {
        sync: 'Sincronizar Colecciones',
        viewDetails: 'Ver Detalles',
        syncAll: 'Sincronizar Todas las Colecciones',
      },

      messages: {
        syncStarted: 'Sincronización de colecciones iniciada',
        syncCompleted: '{count} colecciones sincronizadas correctamente',
        syncFailed: 'No se pudieron sincronizar las colecciones',
      },
    },

    variants: {
      title: 'Variantes',
      variant: 'Variante',
      variantsFromConnection: 'Variantes de {name}',
      variantName: 'Nombre de la variante',
      product: 'Producto',
      sku: 'SKU',
      price: 'Precio',
      inventory: 'Inventario',
      option1: 'Opción 1',
      option2: 'Opción 2',
      option3: 'Opción 3',
      lastSynced: 'Última sincronización',

      actions: {
        sync: 'Sincronizar Variantes',
        viewDetails: 'Ver Detalles',
        syncAll: 'Sincronizar Todas las Variantes',
      },

      messages: {
        syncStarted: 'Sincronización de variantes iniciada',
        syncCompleted: '{count} variantes sincronizadas correctamente',
        syncFailed: 'No se pudieron sincronizar las variantes',
      },
    },

    orders: {
      title: 'Pedidos',
      order: 'Pedido',
      ordersFromConnection: 'Pedidos de {name}',
      orderNumber: 'Número de pedido',
      customer: 'Cliente',
      total: 'Total',
      status: 'Estado',
      financialStatus: 'Estado financiero',
      fulfillmentStatus: 'Estado de cumplimiento',
      date: 'Fecha',
      items: 'Artículos',
      lastSynced: 'Última sincronización',

      statuses: {
        open: 'Abierto',
        archived: 'Archivado',
        cancelled: 'Cancelado',
      },

      financialStatuses: {
        pending: 'Pendiente',
        authorized: 'Autorizado',
        partiallyPaid: 'Parcialmente pagado',
        paid: 'Pagado',
        partiallyRefunded: 'Parcialmente reembolsado',
        refunded: 'Reembolsado',
        voided: 'Anulado',
      },

      fulfillmentStatuses: {
        fulfilled: 'Completado',
        partial: 'Parcial',
        unfulfilled: 'Sin completar',
        restocked: 'Reabastecido',
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
      customerName: 'Nombre del cliente',
      email: 'Correo electrónico',
      phone: 'Teléfono',
      ordersCount: 'Pedidos',
      totalSpent: 'Total gastado',
      lastOrder: 'Último pedido',
      state: 'Estado',
      lastSynced: 'Última sincronización',

      states: {
        disabled: 'Desactivado',
        invited: 'Invitado',
        enabled: 'Activado',
        declined: 'Rechazado',
      },

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

    fulfillments: {
      title: 'Cumplimientos',
      fulfillment: 'Cumplimiento',
      fulfillmentsFromConnection: 'Cumplimientos de {name}',
      order: 'Pedido',
      trackingNumber: 'Número de seguimiento',
      trackingCompany: 'Empresa de seguimiento',
      status: 'Estado',
      shipmentDate: 'Fecha de envío',
      lastSynced: 'Última sincronización',

      statuses: {
        pending: 'Pendiente',
        open: 'Abierto',
        success: 'Correcto',
        cancelled: 'Cancelado',
        error: 'Error',
        failure: 'Fallido',
      },

      actions: {
        sync: 'Sincronizar Cumplimientos',
        viewDetails: 'Ver Detalles',
        syncAll: 'Sincronizar Todos los Cumplimientos',
      },

      messages: {
        syncStarted: 'Sincronización de cumplimientos iniciada',
        syncCompleted: '{count} cumplimientos sincronizados correctamente',
        syncFailed: 'No se pudieron sincronizar los cumplimientos',
      },
    },

    logs: {
      title: 'Registros de sincronización',
      log: 'Registro',
      timestamp: 'Marca de tiempo',
      action: 'Acción',
      connection: 'Conexión',
      status: 'Estado',
      details: 'Detalles',
      allConnections: 'Todas las conexiones',
      filterByConnection: 'Filtrar por conexión',

      statuses: {
        success: 'Correcto',
        error: 'Error',
        warning: 'Advertencia',
        info: 'Información',
      },

      actions: {
        refresh: 'Actualizar registros',
        clearLogs: 'Borrar registros',
        exportLogs: 'Exportar registros',
      },
    },
  };
