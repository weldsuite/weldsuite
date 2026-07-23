// Test stub for `@weldsuite/api-client/client`.
//
// `createClientApi` is a jest mock so tests can capture the options that
// `services/app-api.ts` passes in (notably the `getToken` callback) and assert
// on the token-getter wiring. Defaults to returning a harmless sentinel client.
const createClientApi = jest.fn(() => ({ __stub: 'client' }));

// Mirrors the real NetworkError / isNetworkError from packages/clients/api-client so
// cache-fallback paths that branch on `isNetworkError(err)` behave in tests.
class NetworkError extends Error {
  constructor(message = 'Network request failed', cause) {
    super(message);
    this.name = 'NetworkError';
    this.isNetworkError = true;
    this.cause = cause;
  }
}
const isNetworkError = (err) =>
  err instanceof NetworkError || (typeof err === 'object' && err !== null && err.isNetworkError === true);

// Mirrors the real ApiError / isApiError so screens that branch on
// `isApiError(err) && err.status === 404` behave in tests.
class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.isApiError = true;
    this.status = status;
    this.body = body;
  }
}
const isApiError = (err) =>
  err instanceof ApiError || (typeof err === 'object' && err !== null && err.isApiError === true);

module.exports = { createClientApi, NetworkError, isNetworkError, ApiError, isApiError };
