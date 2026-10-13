/**
 * Warmup corpus access. Implemented in the WeldReach warmup build.
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

import type { Env } from '../env';
import type { CorpusPerson, CorpusThread, RenderedCorpusMessage } from './types';

export type { CorpusMessage, CorpusPerson, CorpusThread, RenderedCorpusMessage } from './types';

export async function loadCorpus(_env: Env): Promise<CorpusThread[]> {
  throw new Error('loadCorpus: not implemented yet');
}

export function renderCorpusMessage(
  _thread: CorpusThread,
  _step: number,
  _sender: CorpusPerson,
  _recipient: CorpusPerson,
): RenderedCorpusMessage {
  throw new Error('renderCorpusMessage: not implemented yet');
}

export async function refreshCorpus(_env: Env, _now: Date): Promise<{ refreshed: boolean }> {
  throw new Error('refreshCorpus: not implemented yet');
}
