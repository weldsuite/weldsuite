const factory = (label) => () => ({ __domain: label });

module.exports = {
  createWorkspacesApi: factory('workspaces'),
  createDashboardApi: factory('dashboard'),
  createMeApi: factory('me'),
  createPushTokensApi: factory('pushTokens'),
  createWeldHrApi: factory('weldhr'),
  createWeldHrPayrollApi: factory('payroll'),
};
