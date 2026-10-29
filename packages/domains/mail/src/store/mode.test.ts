/**
 * `MailStoreMode` parsing, the pure mode helpers, and `resolveMailStoreMode`'s
 * Flagship lookup + isolate cache.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetMailStoreModeCacheForTests,
  isDowngrade,
  parseMailStoreMode,
  readsFromObject,
  resolveMailStoreMode,
  writesObject,
  writesPostgres,
  type MailStoreModeEnv,
} from './mode';
import { MAILBOX_STORE_FLAG } from './types';

afterEach(() => {
  __resetMailStoreModeCacheForTests();
  vi.restoreAllMocks();
});

describe('parseMailStoreMode', () => {
  it('accepts every known mode', () => {
    expect(parseMailStoreMode('postgres')).toBe('postgres');
    expect(parseMailStoreMode('shadow')).toBe('shadow');
    expect(parseMailStoreMode('object')).toBe('object');
    expect(parseMailStoreMode('object-only')).toBe('object-only');
  });

  it('falls back to postgres for anything unknown', () => {
    expect(parseMailStoreMode('enforce')).toBe('postgres'); // a different flag's value
    expect(parseMailStoreMode('OBJECT')).toBe('postgres'); // case-sensitive
    expect(parseMailStoreMode('')).toBe('postgres');
    expect(parseMailStoreMode(undefined)).toBe('postgres');
    expect(parseMailStoreMode(null)).toBe('postgres');
    expect(parseMailStoreMode(42)).toBe('postgres');
    expect(parseMailStoreMode({ mode: 'object' })).toBe('postgres');
  });
});

describe('readsFromObject', () => {
  it('is true only for object and object-only', () => {
    expect(readsFromObject('postgres')).toBe(false);
    expect(readsFromObject('shadow')).toBe(false);
    expect(readsFromObject('object')).toBe(true);
    expect(readsFromObject('object-only')).toBe(true);
  });
});

describe('writesPostgres', () => {
  it('is true for every mode except object-only', () => {
    expect(writesPostgres('postgres')).toBe(true);
    expect(writesPostgres('shadow')).toBe(true);
    expect(writesPostgres('object')).toBe(true);
    expect(writesPostgres('object-only')).toBe(false);
  });
});

describe('writesObject', () => {
  it('is true for every mode except postgres', () => {
    expect(writesObject('postgres')).toBe(false);
    expect(writesObject('shadow')).toBe(true);
    expect(writesObject('object')).toBe(true);
    expect(writesObject('object-only')).toBe(true);
  });
});

describe('isDowngrade', () => {
  it('is true only when the next mode relies on Postgres more than the previous one', () => {
    expect(isDowngrade('object-only', 'object')).toBe(true);
    expect(isDowngrade('object-only', 'postgres')).toBe(true);
    expect(isDowngrade('object', 'shadow')).toBe(true);
    expect(isDowngrade('shadow', 'postgres')).toBe(true);
  });

  it('is false for staying put or moving further from Postgres', () => {
    expect(isDowngrade('postgres', 'postgres')).toBe(false);
    expect(isDowngrade('postgres', 'shadow')).toBe(false);
    expect(isDowngrade('shadow', 'object')).toBe(false);
    expect(isDowngrade('object', 'object-only')).toBe(false);
  });
});

function fakeFlagship(value: string | Error) {
  return {
    getStringValue: vi.fn(async (_key: string, _defaultValue: string, _context?: Record<string, unknown>) => {
      if (value instanceof Error) throw value;
      return value;
    }),
  };
}

describe('resolveMailStoreMode', () => {
  it('resolves to postgres with no FLAGSHIP binding (local wrangler dev)', async () => {
    const env: MailStoreModeEnv = {};
    await expect(resolveMailStoreMode(env, 'ws_1')).resolves.toBe('postgres');
  });

  it('returns the parsed Flagship value', async () => {
    const flagship = fakeFlagship('shadow');
    const env: MailStoreModeEnv = { FLAGSHIP: flagship };
    await expect(resolveMailStoreMode(env, 'ws_1')).resolves.toBe('shadow');
  });

  it('passes the flag key, default and workspace/environment/app context to Flagship', async () => {
    const flagship = fakeFlagship('object');
    const env: MailStoreModeEnv = { FLAGSHIP: flagship, ENVIRONMENT: 'test' };
    await resolveMailStoreMode(env, 'ws_1', { app: 'crm-api' });
    expect(flagship.getStringValue).toHaveBeenCalledWith(MAILBOX_STORE_FLAG, '__unresolved__', {
      workspaceId: 'ws_1',
      environment: 'test',
      app: 'crm-api',
    });
  });

  it('defaults the app attribute to mail-api', async () => {
    const flagship = fakeFlagship('postgres');
    await resolveMailStoreMode({ FLAGSHIP: flagship }, 'ws_1');
    expect(flagship.getStringValue).toHaveBeenCalledWith(
      MAILBOX_STORE_FLAG,
      '__unresolved__',
      expect.objectContaining({ app: 'mail-api' }),
    );
  });

  it('falls back to postgres and never throws on a Flagship error with no mode seen before', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env: MailStoreModeEnv = { FLAGSHIP: fakeFlagship(new Error('flagship down')) };
    await expect(resolveMailStoreMode(env, 'ws_1')).resolves.toBe('postgres');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('treats getting the default back as no answer, not as postgres', async () => {
    // The binding returns the default on a miss or error rather than throwing.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flagship = vi.fn(async (_key: string, defaultValue: string) => defaultValue);
    const env: MailStoreModeEnv = { FLAGSHIP: { getStringValue: flagship } };
    let now = 1_000;
    const clock = () => now;

    flagship.mockResolvedValueOnce('object-only');
    await resolveMailStoreMode(env, 'ws_1', { now: clock });
    now += 30_001;
    await expect(resolveMailStoreMode(env, 'ws_1', { now: clock })).resolves.toBe('object-only');
    error.mockRestore();
  });

  it('keeps serving the last known mode past its TTL while Flagship fails, then picks up the answer again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flagship = vi.fn(async (_key: string, _def: string): Promise<string> => 'object-only');
    const env: MailStoreModeEnv = { FLAGSHIP: { getStringValue: flagship } };
    let now = 1_000;
    const clock = () => now;

    await expect(resolveMailStoreMode(env, 'ws_1', { now: clock })).resolves.toBe('object-only');

    flagship.mockRejectedValue(new Error('flagship down'));
    now += 60_000;
    await expect(resolveMailStoreMode(env, 'ws_1', { now: clock })).resolves.toBe('object-only');
    now += 60 * 60 * 1000;
    // Another workspace's lookup prunes the cache; the stale entry survives it.
    await resolveMailStoreMode(env, 'ws_2', { now: clock });
    await expect(resolveMailStoreMode(env, 'ws_1', { now: clock })).resolves.toBe('object-only');

    flagship.mockResolvedValue('object');
    await expect(resolveMailStoreMode(env, 'ws_1', { now: clock })).resolves.toBe('object');
    error.mockRestore();
  });

  it('never caches the postgres fallback: the next request asks Flagship again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flagship = vi.fn(async (_key: string, _def: string): Promise<string> => {
      throw new Error('flagship down');
    });
    const env: MailStoreModeEnv = { FLAGSHIP: { getStringValue: flagship } };
    let now = 1_000;
    const clock = () => now;

    await expect(resolveMailStoreMode(env, 'ws_1', { now: clock })).resolves.toBe('postgres');
    flagship.mockResolvedValue('object-only');
    now += 1;
    await expect(resolveMailStoreMode(env, 'ws_1', { now: clock })).resolves.toBe('object-only');
    expect(flagship).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('falls back to postgres when Flagship returns an unknown value', async () => {
    const env: MailStoreModeEnv = { FLAGSHIP: fakeFlagship('not-a-real-mode') };
    await expect(resolveMailStoreMode(env, 'ws_1')).resolves.toBe('postgres');
  });

  it('caches per workspace within the TTL: a second call does not re-evaluate Flagship', async () => {
    const flagship = fakeFlagship('object');
    const env: MailStoreModeEnv = { FLAGSHIP: flagship };
    let now = 1_000;
    const clock = () => now;

    await resolveMailStoreMode(env, 'ws_1', { now: clock });
    now += 1_000;
    const second = await resolveMailStoreMode(env, 'ws_1', { now: clock });

    expect(second).toBe('object');
    expect(flagship.getStringValue).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates once the cache entry expires', async () => {
    const flagship = fakeFlagship('object');
    const env: MailStoreModeEnv = { FLAGSHIP: flagship };
    let now = 1_000;
    const clock = () => now;

    await resolveMailStoreMode(env, 'ws_1', { now: clock });
    now += 30_001; // past the 30s TTL
    await resolveMailStoreMode(env, 'ws_1', { now: clock });

    expect(flagship.getStringValue).toHaveBeenCalledTimes(2);
  });

  it('caches each workspace independently', async () => {
    const flagship = vi.fn(async (_key: string, _def: string, context?: Record<string, unknown>) =>
      context?.workspaceId === 'ws_2' ? 'object-only' : 'shadow',
    );
    const env: MailStoreModeEnv = { FLAGSHIP: { getStringValue: flagship } };

    await expect(resolveMailStoreMode(env, 'ws_1')).resolves.toBe('shadow');
    await expect(resolveMailStoreMode(env, 'ws_2')).resolves.toBe('object-only');
    expect(flagship).toHaveBeenCalledTimes(2);
  });
});
