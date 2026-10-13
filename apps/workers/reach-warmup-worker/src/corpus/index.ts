/**
 * Warmup corpus access.
 *
 * CONTRACT:
 *   loadCorpus(env) → the current corpus: the latest generated set in R2
 *     (`reach-warmup/corpus/latest.json`) when present and valid, else the
 *     built-in English set shipped with the worker. Never empty.
 *   renderCorpusMessage(thread, step, sender, recipient) → subject + text of
 *     message `step` (0-based) with names filled in; replies get "Re: ".
 *   refreshCorpus(env, now) → generates a new set with @weldsuite/ai and
 *     stores it in R2 when the stored set is older than 30 days; no-op otherwise.
 */

export type { CorpusMessage, CorpusPerson, CorpusThread, RenderedCorpusMessage } from './types';

export { BUILTIN_CORPUS } from './builtin';
export { refreshCorpus } from './generate';
export { loadCorpus } from './load';
export { renderCorpusMessage } from './render';
export { parseCorpusThread, parseCorpusThreads } from './validate';
