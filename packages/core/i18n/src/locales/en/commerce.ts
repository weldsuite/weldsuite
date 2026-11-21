/**
 * WeldCommerce, rebuilt for the EU edition (ADR COM-009). Phase 0: the module
 * shell and its overview; later phases add products, categories and orders.
 */
export const commerce = {
  appTitle: 'WeldCommerce',
  notInstalled: 'WeldCommerce is not installed in this workspace.',
  overview: {
    loadFailed: 'Could not load the overview.',
    products: 'Products',
    productsHint: '{active} active · {draft} draft',
    openOrders: 'Open orders',
    awaitingFulfilment: 'Awaiting fulfilment',
    unpaid: 'Unpaid',
    revenueTitle: 'Revenue, last 30 days',
    revenueDescription: 'Orders from every channel, cancelled and failed orders left out.',
    revenueOrders: '{count} orders',
    revenueEmpty: 'No orders in the last 30 days.',
    recentTitle: 'Recent orders',
    recentEmpty: 'No orders yet. Orders from Shopify and WooCommerce show up here once they are imported.',
    columns: {
      order: 'Order',
      customer: 'Customer',
      status: 'Status',
      payment: 'Payment',
      fulfilment: 'Fulfilment',
      total: 'Total',
      date: 'Date',
    },
    comingSoon: 'Products, categories and orders arrive in the next updates of WeldCommerce.',
  },
};
