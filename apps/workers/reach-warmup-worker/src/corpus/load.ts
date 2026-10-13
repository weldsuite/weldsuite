/** Which corpus the planner sees: the stored generated set, else the built-in one. */

import type { Env } from '../env';
import { BUILTIN_CORPUS } from './builtin';
import { CORPUS_CACHE_TTL_MS, CORPUS_LATEST_KEY, CORPUS_PREVIOUS_KEY, MIN_STORED_THREADS } from './constants';
import type { CorpusThread } from './types';
import { parseCorpusThreads } from './validate';

interface CachedCorpus {
  corpus: readonly CorpusThread[];
  expiresAt: number;
}

/** Per isolate; the corpus changes once a month, so an hour of staleness is harmless. */
let cached: CachedCorpus | null = null;

/** The replaced set, for lookups only (see loadCorpusForLookup). */
let cachedPrevious: CachedCorpus | null = null;

/** Forget the cached corpus (after a refresh wrote a new one, and between tests). */
export function resetCorpusCache(): void {
  cached = null;
  cachedPrevious = null;
}

/** The set a refresh replaced, or nothing. Never throws. */
async function readPreviousCorpus(env: Env): Promise<readonly CorpusThread[]> {
  const now = Date.now();
  if (cachedPrevious && cachedPrevious.expiresAt > now) return cachedPrevious.corpus;
  let corpus: CorpusThread[] = [];
  try {
    const object = env.STORAGE ? await env.STORAGE.get(CORPUS_PREVIOUS_KEY) : null;
    if (object) corpus = parseCorpusThreads(JSON.parse(await object.text()));
  } catch (err) {
    console.warn('[reach-warmup] previous corpus unreadable:', err instanceof Error ? err.message : err);
  }
  cachedPrevious = { corpus, expiresAt: now + CORPUS_CACHE_TTL_MS };
  return corpus;
}

/** The stored set when it exists and has enough valid threads, else null. Never throws. */
async function readStoredCorpus(env: Env): Promise<CorpusThread[] | null> {
  if (!env.STORAGE) return null;
  try {
    const object = await env.STORAGE.get(CORPUS_LATEST_KEY);
    if (!object) return null;
    const threads = parseCorpusThreads(JSON.parse(await object.text()));
    if (threads.length < MIN_STORED_THREADS) {
      console.warn(
        `[reach-warmup] stored corpus has ${threads.length} valid threads (need ${MIN_STORED_THREADS}), using the built-in set`,
      );
      return null;
    }
    return threads;
  } catch (err) {
    console.warn('[reach-warmup] stored corpus unreadable, using the built-in set:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The current corpus: the latest generated set from R2 when present and valid
 * (at least {@link MIN_STORED_THREADS} valid threads), else the built-in set.
 * Never empty.
 */
export async function loadCorpus(env: Env): Promise<CorpusThread[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return [...cached.corpus];
  const corpus = (await readStoredCorpus(env)) ?? BUILTIN_CORPUS;
  cached = { corpus, expiresAt: now + CORPUS_CACHE_TTL_MS };
  return [...corpus];
}

/**
 * Every thread warmup mail may still reference: the current set, the one the
 * last refresh replaced, and the built-in set. The sender and the engager look
 * threads up here, so mail planned before a monthly refresh still renders; the
 * planner only picks new threads from loadCorpus.
 */
export async function loadCorpusForLookup(env: Env): Promise<CorpusThread[]> {
  const [current, previous] = await Promise.all([loadCorpus(env), readPreviousCorpus(env)]);
  const byId = new Map<string, CorpusThread>();
  for (const thread of [...BUILTIN_CORPUS, ...previous, ...current]) byId.set(thread.id, thread);
  return [...byId.values()];
}
