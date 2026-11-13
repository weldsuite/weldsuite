// Stands in for @weldsuite/mobile-platform/api, which needs the booted server
// runtime. The host choice and the request helper are tested in mobile-platform.
const requestInit = jest.fn();
const createMobileApiClient = jest.fn(() => ({ client: { __stub: 'client' }, requestInit }));

module.exports = { createMobileApiClient };
