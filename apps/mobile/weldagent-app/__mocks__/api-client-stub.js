// Test stub for `@weldsuite/api-client/client`.
//
// `createClientApi` returns a shared fake whose verbs are jest mocks, so tests
// can script app-api responses per path and assert on the request bodies the
// service layer builds. `__client` is exported so a test can reach the same
// instance `services/app-api.ts` captured at module load.
const client = {
  get: jest.fn(),
  getRaw: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
  postForm: jest.fn(),
};

const createClientApi = jest.fn(() => client);

/** Reset every verb between tests. */
function resetClient() {
  for (const fn of Object.values(client)) fn.mockReset();
}

class NetworkError extends Error {
  constructor(message = 'Network request failed', cause) {
    super(message);
    this.name = 'NetworkError';
    this.isNetworkError = true;
    this.cause = cause;
  }
}
const isNetworkError = (err) =>
  err instanceof NetworkError ||
  (typeof err === 'object' && err !== null && err.isNetworkError === true);

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

module.exports = {
  createClientApi,
  __client: client,
  __resetClient: resetClient,
  NetworkError,
  isNetworkError,
  ApiError,
  isApiError,
};
