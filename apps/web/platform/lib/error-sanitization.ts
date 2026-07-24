/**
 * Error Sanitization Utility
 * Prevents sensitive information leakage in error responses
 */

export interface SanitizedError {
  message: string;
  statusCode: number;
  timestamp: string;
  path?: string;
}

/**
 * Sanitizes errors for client consumption
 * Removes stack traces, internal paths, and sensitive data
 */
export function sanitizeError(
  error: unknown,
  defaultMessage: string = 'An unexpected error occurred',
  statusCode: number = 500,
  path?: string
): SanitizedError {
  const sanitized: SanitizedError = {
    message: defaultMessage,
    statusCode,
    timestamp: new Date().toISOString(),
    path,
  };

  // In production, never expose detailed error information
  if (import.meta.env.PROD) {
    return sanitized;
  }

  // In development, provide more context (but still sanitized)
  if (error instanceof Error) {
    sanitized.message = error.message;
  } else if (typeof error === 'string') {
    sanitized.message = error;
  }

  return sanitized;
}

