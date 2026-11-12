// Test stub for `@weldsuite/mobile-platform/api`.
//
// The real module reads the booted server runtime (`getMobileRuntime()` throws
// before boot). Here the origins are fixed, and `createMobileApiClient` builds
// on the `createClientApi` mock so tests can capture the `getToken` wiring.
const { createClientApi } = require('./api-client-stub');

const origins = {
  api: 'https://app-api.weldsuite.org',
  personal: 'https://personal-api.weldsuite.org',
  realtime: 'wss://realtime.weldsuite.org',
  platform: 'https://app.weldsuite.org',
};

function createMobileApiClient({ appCode, getToken }) {
  const client = createClientApi({
    getToken: () => getToken(),
    getExtraHeaders: () => ({ 'X-Weld-App': appCode }),
  });
  async function requestInit(path) {
    const token = await getToken();
    if (!token) throw new Error('Authentication required');
    return {
      url: `${origins.api}/api${path}`,
      headers: { Authorization: `Bearer ${token}`, 'X-Weld-App': appCode },
    };
  }
  return { client, requestInit };
}

// Builds on first use, like the real one (which also rebuilds on an origin change).
function lazyClient(origin, build) {
  let instance = null;
  return new Proxy({}, {
    get(_target, prop) {
      instance ??= build(origin());
      const value = instance[prop];
      return typeof value === 'function' ? value.bind(instance) : value;
    },
  });
}

module.exports = {
  createMobileApiClient,
  lazyClient,
  apiOrigin: () => origins.api,
  apiOriginForPath: () => origins.api,
  personalApiOrigin: () => origins.personal,
  realtimeUrl: () => origins.realtime,
  platformUrl: () => origins.platform,
};
