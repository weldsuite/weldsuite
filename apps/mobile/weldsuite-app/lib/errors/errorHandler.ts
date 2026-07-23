/**
 * Error Handler Utilities
 *
 * Centralized error handling functions for consistent error management
 * across the application.
 *
 * Note: Alert-based functions have been removed. Use toast notifications
 * from ToastContext in components instead.
 */

export interface AppError {
  message: string;
  code?: string;
  statusCode?: number;
  details?: any;
  timestamp: string;
}

/**
 * Parse API errors into a consistent format
 */
export function parseApiError(error: any): AppError {
  const timestamp = new Date().toISOString();

  // Handle network errors
  if (!error.response) {
    return {
      message: 'Network error. Please check your connection and try again.',
      code: 'NETWORK_ERROR',
      timestamp,
    };
  }

  // Handle API response errors
  const { status, data } = error.response;

  switch (status) {
    case 400:
      return {
        message: data?.error || 'Invalid request. Please check your input.',
        code: 'BAD_REQUEST',
        statusCode: 400,
        details: data,
        timestamp,
      };

    case 401:
      return {
        message: 'Authentication required. Please log in again.',
        code: 'UNAUTHORIZED',
        statusCode: 401,
        timestamp,
      };

    case 403:
      return {
        message: 'You do not have permission to perform this action.',
        code: 'FORBIDDEN',
        statusCode: 403,
        timestamp,
      };

    case 404:
      return {
        message: data?.error || 'The requested resource was not found.',
        code: 'NOT_FOUND',
        statusCode: 404,
        timestamp,
      };

    case 409:
      return {
        message: data?.error || 'This action conflicts with existing data.',
        code: 'CONFLICT',
        statusCode: 409,
        details: data,
        timestamp,
      };

    case 422:
      return {
        message: data?.error || 'Validation failed. Please check your input.',
        code: 'VALIDATION_ERROR',
        statusCode: 422,
        details: data,
        timestamp,
      };

    case 429:
      return {
        message: 'Too many requests. Please try again later.',
        code: 'RATE_LIMIT',
        statusCode: 429,
        timestamp,
      };

    case 500:
      return {
        message: 'Server error. Please try again later.',
        code: 'SERVER_ERROR',
        statusCode: 500,
        timestamp,
      };

    case 503:
      return {
        message: 'Service temporarily unavailable. Please try again later.',
        code: 'SERVICE_UNAVAILABLE',
        statusCode: 503,
        timestamp,
      };

    default:
      return {
        message: data?.error || 'An unexpected error occurred. Please try again.',
        code: 'UNKNOWN_ERROR',
        statusCode: status,
        details: data,
        timestamp,
      };
  }
}

/**
 * Log error to console (and potentially to error tracking service)
 */
export function logError(error: any, context?: string) {
  const timestamp = new Date().toISOString();
  const contextInfo = context ? ` [${context}]` : '';

  console.error(`${timestamp}${contextInfo}:`, error);

  // TODO: Send to error tracking service (e.g., Sentry)
  // Sentry.captureException(error, { tags: { context } });
}

/**
 * Handle async errors with automatic logging
 * Note: Alert functionality removed. Use toast notifications in components instead.
 */
export async function handleAsyncError<T>(
  asyncFn: () => Promise<T>,
  options: {
    onError?: (error: AppError) => void;
    context?: string;
  } = {}
): Promise<T | null> {
  try {
    return await asyncFn();
  } catch (error: any) {
    const appError = parseApiError(error);

    // Log error
    logError(appError, options.context);

    // Call custom error handler
    options.onError?.(appError);

    return null;
  }
}

/**
 * Retry function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelay = 1000
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Check if error is a network error
 */
export function isNetworkError(error: any): boolean {
  return !error.response || error.code === 'NETWORK_ERROR';
}

/**
 * Check if error is an authentication error
 */
export function isAuthError(error: any): boolean {
  return error.response?.status === 401 || error.code === 'UNAUTHORIZED';
}

/**
 * Get user-friendly error message
 */
export function getErrorMessage(error: any): string {
  if (!error) {
    return 'An unexpected error occurred';
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error.message) {
    return error.message;
  }

  return 'An unexpected error occurred';
}
