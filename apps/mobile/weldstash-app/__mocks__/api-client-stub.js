const createClientApi = jest.fn(() => ({ __stub: 'client' }));

class NetworkError extends Error {
  constructor(message, cause) {
    super(message ?? 'Network request failed');
    this.name = 'NetworkError';
    this.isNetworkError = true;
    this.cause = cause;
  }
}
const isNetworkError = (err) =>
  err instanceof NetworkError || (typeof err === 'object' && err !== null && err.isNetworkError === true);

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
