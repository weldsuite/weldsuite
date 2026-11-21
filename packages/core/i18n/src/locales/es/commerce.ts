/**
 * WeldCommerce, reconstruido para la edición UE (ADR COM-009). Fase 0: el
 * módulo y su resumen; productos, categorías y pedidos llegarán después.
 */
export const commerce = {
  appTitle: 'WeldCommerce',
  notInstalled: 'WeldCommerce no está instalado en este espacio de trabajo.',
  overview: {
    loadFailed: 'No se pudo cargar el resumen.',
    products: 'Productos',
    productsHint: '{active} activos · {draft} borradores',
    openOrders: 'Pedidos abiertos',
    awaitingFulfilment: 'Pendientes de envío',
    unpaid: 'Sin pagar',
    revenueTitle: 'Ingresos, últimos 30 días',
    revenueDescription: 'Pedidos de todos los canales, sin los cancelados ni los fallidos.',
    revenueOrders: '{count} pedidos',
    revenueEmpty: 'No hay pedidos en los últimos 30 días.',
    recentTitle: 'Pedidos recientes',
    recentEmpty: 'Aún no hay pedidos. Los pedidos de Shopify y WooCommerce aparecen aquí cuando se importan.',
    columns: {
      order: 'Pedido',
      customer: 'Cliente',
      status: 'Estado',
      payment: 'Pago',
      fulfilment: 'Envío',
      total: 'Total',
      date: 'Fecha',
    },
    comingSoon: 'Los productos, las categorías y los pedidos llegarán en las próximas actualizaciones de WeldCommerce.',
  },
};
