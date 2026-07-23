import { describe, it, expect } from 'vitest';
import { APICallError, RetryError } from 'ai';

import { GatewayConfigError, UnsupportedModelError } from './adapters/types.js';
import {
  AllGatewaysFailedError,
  classifyGatewayError,
  isAuthFailure,
  isBillingFailure,
  unwrapGatewayError,
} from './errors.js';

function apiError(statusCode: number | undefined, opts: { isRetryable?: boolean } = {}) {
  return new APICallError({
    message: `status ${statusCode}`,
    url: 'https://gateway.test/v1/chat/completions',
    requestBodyValues: {},
    statusCode,
    isRetryable: opts.isRetryable,
  });
}

describe('classifyGatewayError — retry elsewhere', () => {
  it.each([500, 502, 503, 504])('treats %s as retryable on another gateway', (status) => {
    expect(classifyGatewayError(apiError(status))).toBe('retry-elsewhere');
  });

  it('treats 429 as retry-elsewhere (rate limits are per-gateway)', () => {
    expect(classifyGatewayError(apiError(429))).toBe('retry-elsewhere');
  });

  // The single most important case in this file — see errors.ts header.
  it('treats 402 as retry-elsewhere, NOT terminal', () => {
    expect(classifyGatewayError(apiError(402))).toBe('retry-elsewhere');
  });

  it('treats 401/403 as retry-elsewhere (each gateway has its own credential)', () => {
    expect(classifyGatewayError(apiError(401))).toBe('retry-elsewhere');
    expect(classifyGatewayError(apiError(403))).toBe('retry-elsewhere');
  });

  it('treats 404 as retry-elsewhere (catalog drift)', () => {
    expect(classifyGatewayError(apiError(404))).toBe('retry-elsewhere');
  });

  it('defers to the SDK for a status-less network error', () => {
    expect(classifyGatewayError(apiError(undefined, { isRetryable: true }))).toBe('retry-elsewhere');
    expect(classifyGatewayError(apiError(undefined, { isRetryable: false }))).toBe('terminal');
  });
});

describe('classifyGatewayError — terminal', () => {
  it('treats 400 as terminal (a malformed prompt fails everywhere)', () => {
    expect(classifyGatewayError(apiError(400))).toBe('terminal');
  });

  it('treats an unrecognised 4xx as terminal', () => {
    expect(classifyGatewayError(apiError(422))).toBe('terminal');
  });

  it('treats our own pre-flight errors as terminal', () => {
    expect(classifyGatewayError(new UnsupportedModelError('@cf/x', 'cloudflare'))).toBe('terminal');
    expect(classifyGatewayError(new GatewayConfigError('cloudflare', 'KEY'))).toBe('terminal');
  });

  it('fails CLOSED on an unrecognised error — never spray an unknown bug across gateways', () => {
    expect(classifyGatewayError(new TypeError('x is not a function'))).toBe('terminal');
    expect(classifyGatewayError(new Error('boom'))).toBe('terminal');
    expect(classifyGatewayError('a string')).toBe('terminal');
    expect(classifyGatewayError(undefined)).toBe('terminal');
  });
});

describe('unwrapGatewayError', () => {
  it('peels RetryError down to the real cause', () => {
    const real = apiError(429);
    const wrapped = new RetryError({
      message: 'failed after 2 attempts',
      reason: 'maxRetriesExceeded',
      errors: [real],
    });
    expect(unwrapGatewayError(wrapped)).toBe(real);
  });

  // Without unwrapping, the wrapper is not an APICallError -> everything would
  // classify as terminal and fallback would never happen.
  it('classifies through a RetryError wrapper', () => {
    const wrapped = new RetryError({
      message: 'failed',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503)],
    });
    expect(classifyGatewayError(wrapped)).toBe('retry-elsewhere');
  });

  it('returns non-wrapped errors untouched', () => {
    const err = apiError(400);
    expect(unwrapGatewayError(err)).toBe(err);
  });
});

describe('cross-copy marker safety', () => {
  // The tree holds TWO @ai-sdk/provider copies (hoisted + nested under `ai`).
  // isInstance compares Symbol.for() markers via the GLOBAL registry, so an
  // error built by one copy must classify correctly in code using the other.
  // If this ever fails, every provider error silently becomes 'terminal'.
  it('classifies an APICallError built from the hoisted copy', async () => {
    const hoisted = await import('@ai-sdk/provider');
    const err = new hoisted.APICallError({
      message: 'boom',
      url: 'https://gateway.test',
      requestBodyValues: {},
      statusCode: 503,
    });
    expect(APICallError.isInstance(err)).toBe(true);
    expect(classifyGatewayError(err)).toBe('retry-elsewhere');
  });
});

describe('failure predicates', () => {
  it('detects auth vs billing failures', () => {
    expect(isAuthFailure(apiError(401))).toBe(true);
    expect(isAuthFailure(apiError(403))).toBe(true);
    expect(isAuthFailure(apiError(500))).toBe(false);
    expect(isBillingFailure(apiError(402))).toBe(true);
    expect(isBillingFailure(apiError(401))).toBe(false);
  });

  it('sees through a RetryError wrapper', () => {
    const wrapped = new RetryError({
      message: 'failed',
      reason: 'maxRetriesExceeded',
      errors: [apiError(402)],
    });
    expect(isBillingFailure(wrapped)).toBe(true);
  });
});

describe('AllGatewaysFailedError', () => {
  it('names the gateways tried and surfaces the last error message', () => {
    const last = apiError(503);
    const err = new AllGatewaysFailedError(
      [{ gateway: 'cloudflare', ok: false, kind: 'retry-elsewhere', durationMs: 12 }],
      last,
    );
    expect(err.message).toMatch(/cloudflare/);
    expect(err.message).toMatch(/status 503/);
    expect(err.cause).toBe(last);
    expect(err.attempts).toHaveLength(1);
  });
});
