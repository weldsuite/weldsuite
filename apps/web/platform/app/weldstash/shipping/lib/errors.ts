/**
 * Reads the stash module's error envelope (`{ error: { code, message, details } }`)
 * for the carrier and label screens: a translated line per known code, plus the
 * carrier's own messages (`details.messages`) when it refused something.
 */

import { isApiError } from '@weldsuite/api-client';

export interface ShippingErrorInfo {
  code: string | null;
  status: number | null;
  /** One line for the failure: the translation of `code`, else the server's message. */
  message: string;
  /** The carrier's own reasons (`details.messages`), shown as a list. */
  messages: string[];
}

interface ErrorBody {
  code?: string;
  message?: string;
  details?: { messages?: unknown };
}

function errorBody(error: unknown): ErrorBody {
  if (!isApiError(error)) return {};
  const body = error.body as { error?: ErrorBody | string } | undefined;
  return typeof body?.error === 'object' && body.error !== null ? body.error : {};
}

export function shippingErrorInfo(error: unknown, translated: Readonly<Record<string, string>>, fallback: string): ShippingErrorInfo {
  const body = errorBody(error);
  const code = body.code ?? null;
  const rawMessages = body.details?.messages;
  const messages = Array.isArray(rawMessages) ? rawMessages.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
  const message =
    (code ? translated[code] : undefined) ?? (error instanceof Error && error.message ? error.message : fallback);
  return { code, status: isApiError(error) ? error.status : null, message, messages };
}
