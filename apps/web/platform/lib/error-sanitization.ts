/**
 * Error Sanitization Utility
 * Prevents sensitive information leakage in error responses
 */

import { log } from '@/lib/logger';

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

/**
 * Logs errors server-side with full context
 * Use this before returning sanitized errors to clients
 */
function logError(
  error: unknown,
  context: {
    path?: string;
    method?: string;
    userId?: string;
    workspaceId?: string;
    [key: string]: unknown;
  } = {}
): void {
  const timestamp = new Date().toISOString();
  const errorInfo = {
    timestamp,
    ...context,
    error: error instanceof Error ? {
      name: error.name,
      message: error.message,
      stack: error.stack,
    } : error,
  };

  log.error('Application error', errorInfo as Record<string, unknown>);
}

/**
 * Combined helper: log server-side and return sanitized error
 */
function handleError(
  error: unknown,
  context: {
    path?: string;
    method?: string;
    userId?: string;
    workspaceId?: string;
    defaultMessage?: string;
    statusCode?: number;
  } = {}
): SanitizedError {
  // Log full error server-side
  logError(error, context);

  // Return sanitized error for client
  return sanitizeError(
    error,
    context.defaultMessage,
    context.statusCode,
    context.path
  );
}
