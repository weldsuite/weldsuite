// Stand-in for `@weldsuite/mobile-platform/api` in Jest: the real client needs the
// server runtime booted. Tests assert what `services/app-api.ts` hands to it.
const createMobileApiClient = jest.fn(() => ({
  client: { __stub: 'client' },
  requestInit: jest.fn(),
}));

module.exports = { createMobileApiClient };
