import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { BUILTIN_CORPUS } from './builtin';
import { CORPUS_CACHE_TTL_MS, CORPUS_LATEST_KEY, MIN_STORED_THREADS } from './constants';
import { createFakeR2 } from './fake-r2.test-helper';
import { loadCorpus, resetCorpusCache } from './load';
import type { CorpusThread } from './types';

function envWith(storage?: R2Bucket): Env {
  return { ENVIRONMENT: 'test', DATABASE_URL_MASTER: 'postgres://unused', STORAGE: storage };
}

/** `count` valid threads with ids "gen-2026-10-001" onwards (reworked built-in threads). */
function generated(count: number): CorpusThread[] {
  return BUILTIN_CORPUS.slice(0, count).map((thread, index) => ({
    ...thread,
    id: `gen-2026-10-${String(index + 1).padStart(3, '0')}`,
  }));
}

const BUILTIN_IDS = BUILTIN_CORPUS.map((thread) => thread.id);

describe('loadCorpus', () => {
  beforeEach(() => {
    resetCorpusCache();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('falls back to the built-in set without a bucket', async () => {
    const corpus = await loadCorpus(envWith());
    expect(corpus.map((thread) => thread.id)).toEqual(BUILTIN_IDS);
  });

  it('falls back to the built-in set when latest.json is missing', async () => {
    const r2 = createFakeR2();
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus.map((thread) => thread.id)).toEqual(BUILTIN_IDS);
    expect(r2.gets()).toBe(1);
  });

  it('falls back when latest.json is not valid JSON', async () => {
    const r2 = createFakeR2({ [CORPUS_LATEST_KEY]: '{ not json' });
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus.map((thread) => thread.id)).toEqual(BUILTIN_IDS);
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back when latest.json is not an array of threads', async () => {
    const r2 = createFakeR2({ [CORPUS_LATEST_KEY]: JSON.stringify({ threads: generated(40) }) });
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus.map((thread) => thread.id)).toEqual(BUILTIN_IDS);
  });

  it('falls back when fewer than the minimum number of threads are valid', async () => {
    const stored = [...generated(MIN_STORED_THREADS - 1), { id: 'broken', subject: 'Re: nope', messages: [] }];
    const r2 = createFakeR2({ [CORPUS_LATEST_KEY]: JSON.stringify(stored) });
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus.map((thread) => thread.id)).toEqual(BUILTIN_IDS);
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back when reading R2 throws', async () => {
    const r2 = createFakeR2({}, { failGet: true });
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus.map((thread) => thread.id)).toEqual(BUILTIN_IDS);
  });

  it('uses a valid stored set', async () => {
    const stored = generated(40);
    const r2 = createFakeR2({ [CORPUS_LATEST_KEY]: JSON.stringify(stored) });
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus).toEqual(stored);
  });

  it('keeps the valid threads of a stored set that also holds invalid ones', async () => {
    const stored = [...generated(MIN_STORED_THREADS + 2), { id: 'broken', subject: 'Re: nope', messages: [] }];
    const r2 = createFakeR2({ [CORPUS_LATEST_KEY]: JSON.stringify(stored) });
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus).toHaveLength(MIN_STORED_THREADS + 2);
    expect(corpus.some((thread) => thread.id === 'broken')).toBe(false);
  });

  it('drops stored threads that carry a link, even when the rest is fine', async () => {
    const stored = generated(40);
    const first = stored[0];
    if (!first) throw new Error('fixture');
    const [opening, ...rest] = first.messages;
    if (!opening) throw new Error('fixture');
    stored[0] = { ...first, messages: [{ ...opening, body: 'Hi {{recipientFirstName}}, see http://example.invalid today.' }, ...rest] };
    const r2 = createFakeR2({ [CORPUS_LATEST_KEY]: JSON.stringify(stored) });
    const corpus = await loadCorpus(envWith(r2.bucket));
    expect(corpus).toHaveLength(39);
    expect(corpus.some((thread) => thread.id === first.id)).toBe(false);
  });

  it('caches for an hour per isolate, then reads again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'));
    const r2 = createFakeR2({ [CORPUS_LATEST_KEY]: JSON.stringify(generated(40)) });
    const env = envWith(r2.bucket);

    await loadCorpus(env);
    await loadCorpus(env);
    expect(r2.gets()).toBe(1);

    vi.setSystemTime(new Date(Date.parse('2026-10-13T08:00:00Z') + CORPUS_CACHE_TTL_MS - 1000));
    await loadCorpus(env);
    expect(r2.gets()).toBe(1);

    vi.setSystemTime(new Date(Date.parse('2026-10-13T08:00:00Z') + CORPUS_CACHE_TTL_MS + 1000));
    await loadCorpus(env);
    expect(r2.gets()).toBe(2);
  });

  it('caches the built-in fallback too, and resetCorpusCache forgets it', async () => {
    const r2 = createFakeR2();
    const env = envWith(r2.bucket);
    await loadCorpus(env);
    await loadCorpus(env);
    expect(r2.gets()).toBe(1);

    resetCorpusCache();
    r2.store.set(CORPUS_LATEST_KEY, JSON.stringify(generated(40)));
    const corpus = await loadCorpus(env);
    expect(corpus[0]?.id).toBe('gen-2026-10-001');
  });

  it('hands out a copy, so a caller sorting the list cannot disturb the cache', async () => {
    const env = envWith();
    const first = await loadCorpus(env);
    first.reverse();
    first.length = 0;
    const second = await loadCorpus(env);
    expect(second.map((thread) => thread.id)).toEqual(BUILTIN_IDS);
  });
});
