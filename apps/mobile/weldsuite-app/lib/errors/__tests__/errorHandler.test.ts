import {
  parseApiError,
  getErrorMessage,
  isNetworkError,
  isAuthError,
} from '../errorHandler';

describe('errorHandler', () => {
  describe('parseApiError', () => {
    it('should parse network errors', () => {
      const networkError = { message: 'Network error' };
      const result = parseApiError(networkError);

      expect(result.code).toBe('NETWORK_ERROR');
      expect(result.message).toContain('Network error');
      expect(result.timestamp).toBeDefined();
    });

    it('should parse 400 errors', () => {
      const error = {
        response: {
          status: 400,
          data: { error: 'Invalid input' },
        },
      };
      const result = parseApiError(error);

      expect(result.code).toBe('BAD_REQUEST');
      expect(result.statusCode).toBe(400);
      expect(result.message).toBe('Invalid input');
    });

    it('should parse 401 errors', () => {
      const error = {
        response: {
          status: 401,
          data: {},
        },
      };
      const result = parseApiError(error);

      expect(result.code).toBe('UNAUTHORIZED');
      expect(result.statusCode).toBe(401);
      expect(result.message).toContain('Authentication required');
    });

    it('should parse 403 errors', () => {
      const error = {
        response: {
          status: 403,
          data: {},
        },
      };
      const result = parseApiError(error);

      expect(result.code).toBe('FORBIDDEN');
      expect(result.statusCode).toBe(403);
      expect(result.message).toContain('permission');
    });

    it('should parse 404 errors', () => {
      const error = {
        response: {
          status: 404,
          data: { error: 'User not found' },
        },
      };
      const result = parseApiError(error);

      expect(result.code).toBe('NOT_FOUND');
      expect(result.statusCode).toBe(404);
      expect(result.message).toBe('User not found');
    });

    it('should parse 500 errors', () => {
      const error = {
        response: {
          status: 500,
          data: {},
        },
      };
      const result = parseApiError(error);

      expect(result.code).toBe('SERVER_ERROR');
      expect(result.statusCode).toBe(500);
      expect(result.message).toContain('Server error');
    });

    it('should parse unknown errors', () => {
      const error = {
        response: {
          status: 418,
          data: { error: "I'm a teapot" },
        },
      };
      const result = parseApiError(error);

      expect(result.code).toBe('UNKNOWN_ERROR');
      expect(result.statusCode).toBe(418);
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error object', () => {
      const error = new Error('Test error');
      expect(getErrorMessage(error)).toBe('Test error');
    });

    it('should return string error directly', () => {
      expect(getErrorMessage('Test error')).toBe('Test error');
    });

    it('should extract message from object', () => {
      const error = { message: 'Test error' };
      expect(getErrorMessage(error)).toBe('Test error');
    });

    it('should return default message for unknown error', () => {
      expect(getErrorMessage(null)).toBe('An unexpected error occurred');
      expect(getErrorMessage(undefined)).toBe('An unexpected error occurred');
      expect(getErrorMessage({})).toBe('An unexpected error occurred');
    });
  });

  describe('isNetworkError', () => {
    it('should detect network errors', () => {
      const error = { message: 'Network error' };
      expect(isNetworkError(error)).toBe(true);
    });

    it('should detect NETWORK_ERROR code', () => {
      const error = { code: 'NETWORK_ERROR' };
      expect(isNetworkError(error)).toBe(true);
    });

    it('should return false for API errors', () => {
      const error = {
        response: {
          status: 500,
          data: {},
        },
      };
      expect(isNetworkError(error)).toBe(false);
    });
  });

  describe('isAuthError', () => {
    it('should detect 401 errors', () => {
      const error = {
        response: {
          status: 401,
        },
      };
      expect(isAuthError(error)).toBe(true);
    });

    it('should detect UNAUTHORIZED code', () => {
      const error = { code: 'UNAUTHORIZED' };
      expect(isAuthError(error)).toBe(true);
    });

    it('should return false for non-auth errors', () => {
      const error = {
        response: {
          status: 500,
        },
      };
      expect(isAuthError(error)).toBe(false);
    });
  });
});
