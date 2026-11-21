/**
 * WeldCommerce, reconstruit pour l'édition UE (ADR COM-009). Phase 0 : le
 * module et sa vue d'ensemble ; produits, catégories et commandes suivront.
 */
export const commerce = {
  appTitle: 'WeldCommerce',
  notInstalled: "WeldCommerce n'est pas installé dans cet espace de travail.",
  overview: {
    loadFailed: "Impossible de charger la vue d'ensemble.",
    products: 'Produits',
    productsHint: '{active} actifs · {draft} brouillons',
    openOrders: 'Commandes ouvertes',
    awaitingFulfilment: "En attente d'expédition",
    unpaid: 'Non payées',
    revenueTitle: 'Chiffre d’affaires, 30 derniers jours',
    revenueDescription: 'Commandes de tous les canaux, hors commandes annulées et échouées.',
    revenueOrders: '{count} commandes',
    revenueEmpty: 'Aucune commande ces 30 derniers jours.',
    recentTitle: 'Commandes récentes',
    recentEmpty: "Pas encore de commandes. Les commandes de Shopify et WooCommerce apparaissent ici une fois importées.",
    columns: {
      order: 'Commande',
      customer: 'Client',
      status: 'Statut',
      payment: 'Paiement',
      fulfilment: 'Expédition',
      total: 'Total',
      date: 'Date',
    },
    comingSoon: 'Les produits, les catégories et les commandes arrivent dans les prochaines mises à jour de WeldCommerce.',
  },
};
