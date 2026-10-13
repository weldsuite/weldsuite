/** R2 keys and thresholds shared by the corpus loader and the monthly refresh. */

export const CORPUS_PREFIX = 'reach-warmup/corpus/';
/** The set the planner reads: a JSON array of `CorpusThread`. */
export const CORPUS_LATEST_KEY = `${CORPUS_PREFIX}latest.json`;
/** `{ generatedAt }`: when `latest.json` was produced. */
export const CORPUS_META_KEY = `${CORPUS_PREFIX}meta.json`;

/** A stored set with fewer valid threads than this is ignored in favour of the built-in set. */
export const MIN_STORED_THREADS = 30;
/** A refresh that yields fewer valid threads than this is discarded. */
export const MIN_GENERATED_THREADS = 60;

/** How long one isolate keeps the loaded corpus. */
export const CORPUS_CACHE_TTL_MS = 60 * 60 * 1000;
/** The stored set is replaced once it is older than this. */
export const CORPUS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Placeholders a corpus body may contain; the writer of a message is always the "sender". */
export const PLACEHOLDER_NAMES = [
  'senderFirstName',
  'senderLastName',
  'recipientFirstName',
  'recipientLastName',
] as const;
