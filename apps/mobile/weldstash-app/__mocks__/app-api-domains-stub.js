const factory = (label) => () => ({ __domain: label });

module.exports = {
  createWorkspacesApi: factory('workspaces'),
  createDashboardApi: factory('dashboard'),
  createMeApi: factory('me'),
  createPushTokensApi: factory('pushTokens'),
  createProductsApi: factory('products'),
  createInventoryApi: factory('inventory'),
  createWarehousesApi: factory('warehouses'),
};
