import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sanitizeError } from './error-sanitization';

// `import.meta.env.PROD` defaults to false under Vitest (NODE_ENV=test),
// so the dev-mode branch runs unless we force PROD via a stub.

describe('sanitizeError (dev mode)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the default message when no error is given', () => {
    const result = sanitizeError(undefined);
    expect(result.message).toBe('An unexpected error occurred');
    expect(result.statusCode).toBe(500);
    expect(result.timestamp).toBeTypeOf('string');
  });

  it('exposes the Error message in dev', () => {
    const result = sanitizeError(new Error('boom'));
    expect(result.message).toBe('boom');
  });

  it('exposes a string error in dev', () => {
    const result = sanitizeError('plain string error');
    expect(result.message).toBe('plain string error');
  });

  it('passes through the custom statusCode + path', () => {
    const result = sanitizeError(new Error('x'), 'default', 403, '/api/x');
    expect(result.statusCode).toBe(403);
    expect(result.path).toBe('/api/x');
  });
});

describe('sanitizeError (prod mode)', () => {
  beforeEach(() => {
    vi.stubEnv('PROD', 'true');
  });

  it('NEVER leaks the Error message in production', () => {
    // Vitest's env stub flips import.meta.env.PROD.
    const result = sanitizeError(new Error('SECRET DB PASSWORD: hunter2'));
    expect(result.message).toBe('An unexpected error occurred');
    expect(result.message).not.toContain('hunter2');
  });
});
