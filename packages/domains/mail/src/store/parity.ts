/**
 * The `shadow`-mode parity sampler (design §2.2, §4): for a sampled fraction
 * of single-mailbox `listThreads`/`stats` reads, compare the Postgres result
 * (already in hand — it's the primary) against the object's answer to the
 * same query, in the background, and log a mismatch.
 *
 * Deliberately narrow, matching the design exactly: only `listThreads` and
 * `stats`, only on a single mailbox (never the cross-mailbox fan-out), never
 * for a search query, and the comparison itself never looks at message
 * bodies or content — only ids, counts and label sets, so a mismatch log line
 * carries nothing a mailbox's content would.
 *
 * Known, intended differences, normalised away rather than reported:
 * - **Search is excluded entirely** (`sampleListThreads` returns `null` when
 *   `q.search` is set) — the object's FTS5 token-prefix match and Postgres's
 *   substring `ILIKE` are expected to disagree (design's Risks section).
 * - **AI categories.** The object always keeps a message's `labels_json` and
 *   its derived `important` flag in lockstep (design §3.1's DDL comment:
 *   "derived from labels on every write"); Postgres's `ai.ts:
 *   persistClassification` sets `isImportant` on the row without adding
 *   `IMPORTANT` to the `labels` array (design's "Where the plan or ADR is
 *   wrong" item 9 lists the sibling bugs; this one isn't fixed by this PR).
 *   `threadLabelsForParity` folds every message's flags into its labels with
 *   `../store/model`'s `normalizeLegacy` before comparing, so this known gap
 *   in Postgres's own data never reads as a parity mismatch.
 * - **Empty custom labels.** The object's `label_counts` table has no row for
 *   a label that has never had a message (so `labelCounts` simply omits the
 *   key); Postgres's `stats()` always returns a zero `LabelCount` for every
 *   label `mail_labels` defines. `normalizeLabelCount` treats a missing key on
 *   either side as `{messages:0, unread:0, threads:0}` before comparing.
 * - **Bodies, by presence only.** Neither `listThreads` nor `stats` carries
 *   message bodies (`ThreadSummary.messages` is `ThreadListMessage`, which
 *   excludes `textBody`/`htmlBody`/`rawMessage` by its own type), so this
 *   sampler never touches them. `bodiesPresenceEqual` is exported for the
 *   full-parity comparison (design §4, task C4), which does load bodies, to
 *   reuse — comparing "is there a body" rather than exact content.
 *
 * `MAILBOX_PARITY_SAMPLE_RATE` is read once by `parseParitySampleRate`; the
 * router (task C3's own `router.ts`) owns deciding WHAT happens on a
 * mismatch (it shares the same KV drift marker as a secondary write failure,
 * design §2.2) — this file only detects and reports a diff.
 */

import { normalizeLegacy } from './model';
import type { MailboxRef, MailboxStats, MailboxStore, ThreadListQuery, ThreadPage } from './types';
import type { ThreadSummary } from '../threads';

// ---------------------------------------------------------------------------
// Sample rate
// ---------------------------------------------------------------------------

export const DEFAULT_PARITY_SAMPLE_RATE = 0.05;

export interface ParitySampleRateEnv {
  MAILBOX_PARITY_SAMPLE_RATE?: string;
}

/** Parses `env.MAILBOX_PARITY_SAMPLE_RATE`, clamped to `[0, 1]`. Missing, non-numeric or out-of-range values fall back to the 5% default rather than sampling everything or nothing by accident. */
export function parseParitySampleRate(env: ParitySampleRateEnv): number {
  const raw = env.MAILBOX_PARITY_SAMPLE_RATE;
  if (raw === undefined) return DEFAULT_PARITY_SAMPLE_RATE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return DEFAULT_PARITY_SAMPLE_RATE;
  return value;
}

/** `random() < rate` factored out so a caller can pin `random` for a deterministic test. */
export function shouldSampleParity(rate: number, random: () => number = Math.random): boolean {
  return random() < rate;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface ParityDiff {
  field: string;
  postgres: unknown;
  object: unknown;
}

const MESSAGE_STATS_FIELDS = [
  'total',
  'unread',
  'inboxUnread',
  'starred',
  'importantUnread',
  'sentUnread',
  'archiveUnread',
  'trashUnread',
  'spam',
  'snoozed',
  'scheduled',
  'drafts',
] as const satisfies readonly (keyof MailboxStats)[];

interface LabelCountLike {
  messages: number;
  unread: number;
  threads: number;
}

const ZERO_LABEL_COUNT: LabelCountLike = { messages: 0, unread: 0, threads: 0 };

function normalizeLabelCount(entry: LabelCountLike | undefined): LabelCountLike {
  return entry ?? ZERO_LABEL_COUNT;
}

function labelCountsEqual(a: LabelCountLike, b: LabelCountLike): boolean {
  return a.messages === b.messages && a.unread === b.unread && a.threads === b.threads;
}

/** All `MessageStats` fields, plus every label key present on either side (missing ⇒ zero — see the module doc comment). */
export function compareMailboxStats(pg: MailboxStats, obj: MailboxStats): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  for (const field of MESSAGE_STATS_FIELDS) {
    if (pg[field] !== obj[field]) diffs.push({ field, postgres: pg[field], object: obj[field] });
  }
  const labelKeys = new Set([...Object.keys(pg.labels), ...Object.keys(obj.labels)]);
  for (const key of labelKeys) {
    const pgCount = normalizeLabelCount(pg.labels[key]);
    const objCount = normalizeLabelCount(obj.labels[key]);
    if (!labelCountsEqual(pgCount, objCount)) {
      diffs.push({ field: `labels.${key}`, postgres: pgCount, object: objCount });
    }
  }
  return diffs;
}

/** The thread's label set with every message's `isStarred`/`isImportant`/`isTrash`/`isSpam` folded in via `normalizeLegacy` — undoes the known Postgres-only gap documented above. */
function postgresThreadLabelsForParity(thread: ThreadSummary): Set<string> {
  const labels = new Set<string>();
  for (const message of thread.messages) {
    for (const label of normalizeLegacy({
      labels: message.labels,
      isStarred: message.isStarred,
      isImportant: message.isImportant,
      isTrash: message.isTrash,
      isSpam: message.isSpam,
    })) {
      labels.add(label);
    }
  }
  return labels;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function sortedArray(set: Set<string>): string[] {
  return [...set].sort();
}

/**
 * The first page's thread keys and order, then per thread (present on both
 * sides) `messageCount`, `unreadCount`, `latestMessageId` and the label set
 * (design §2.2/§4).
 */
export function compareThreadPage(pg: ThreadPage, obj: ThreadPage): ParityDiff[] {
  const diffs: ParityDiff[] = [];
  const pgKeys = pg.threads.map((t) => t.threadId);
  const objKeys = obj.threads.map((t) => t.threadId);
  if (pgKeys.length !== objKeys.length || pgKeys.some((key, i) => key !== objKeys[i])) {
    diffs.push({ field: 'threadOrder', postgres: pgKeys, object: objKeys });
  }

  const objByKey = new Map(obj.threads.map((t) => [t.threadId, t]));
  for (const pgThread of pg.threads) {
    const objThread = objByKey.get(pgThread.threadId);
    if (!objThread) continue; // already reflected in the order/membership diff above

    if (pgThread.messageCount !== objThread.messageCount) {
      diffs.push({
        field: `thread.${pgThread.threadId}.messageCount`,
        postgres: pgThread.messageCount,
        object: objThread.messageCount,
      });
    }
    if (pgThread.unreadCount !== objThread.unreadCount) {
      diffs.push({
        field: `thread.${pgThread.threadId}.unreadCount`,
        postgres: pgThread.unreadCount,
        object: objThread.unreadCount,
      });
    }
    if (pgThread.latestMessageId !== objThread.latestMessageId) {
      diffs.push({
        field: `thread.${pgThread.threadId}.latestMessageId`,
        postgres: pgThread.latestMessageId,
        object: objThread.latestMessageId,
      });
    }

    const pgLabels = postgresThreadLabelsForParity(pgThread);
    const objLabels = new Set(objThread.labels);
    if (!setsEqual(pgLabels, objLabels)) {
      diffs.push({
        field: `thread.${pgThread.threadId}.labels`,
        postgres: sortedArray(pgLabels),
        object: sortedArray(objLabels),
      });
    }
  }

  return diffs;
}

/**
 * Whether two sides "have a body" the same way — exact content is never
 * compared (design: parity carries counts and ids, never content). Not used
 * by this file's own `listThreads`/`stats` sampling (neither carries
 * bodies); exported for task C4's full-parity comparison, which does load
 * them.
 */
export function bodiesPresenceEqual(
  pg: { textBody?: string | null; htmlBody?: string | null },
  obj: { textBody?: string | null; htmlBody?: string | null },
): boolean {
  const presence = (v: string | null | undefined) => !!v;
  return presence(pg.textBody) === presence(obj.textBody) && presence(pg.htmlBody) === presence(obj.htmlBody);
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

export type ParityKind = 'listThreads' | 'stats';

export interface ParityMismatch {
  ref: MailboxRef;
  kind: ParityKind;
  diffs: ParityDiff[];
}

export type ParityMismatchHandler = (mismatch: ParityMismatch) => void | Promise<void>;

export interface ParitySamplerOptions {
  rate: number;
  /** Test seam: defaults to `Math.random`. */
  random?: () => number;
  /** Called (never thrown) when a sampled comparison finds a diff. Defaults to a `console.warn` matching design §2.2's `mailbox_parity` log line. */
  onMismatch?: ParityMismatchHandler;
}

/** design §2.2's `mailbox_parity` log line: ids and counts only, never content. The router's own `onMismatch` (when it overrides this default) calls this too, so a mismatch is always logged regardless of what else happens with it (e.g. the KV drift marker). */
export function logParityMismatch({ ref, kind, diffs }: ParityMismatch): void {
  console.warn(
    '[mail-store] mailbox_parity',
    JSON.stringify({ workspaceId: ref.workspaceId, accountId: ref.accountId, kind, diffCount: diffs.length, fields: diffs.map((d) => d.field) }),
  );
}

/**
 * Samples `shadow`-mode single-mailbox reads for parity against the object,
 * entirely in the background: every public method here either returns `null`
 * (nothing to sample this call) or a `Promise<void>` the caller passes to
 * `waitUntil` — it never throws, and never delays or changes the read it is
 * sampling.
 */
export class ParitySampler {
  private readonly rate: number;
  private readonly random: () => number;
  private readonly onMismatch: ParityMismatchHandler;

  constructor(options: ParitySamplerOptions) {
    this.rate = options.rate;
    this.random = options.random ?? Math.random;
    this.onMismatch = options.onMismatch ?? logParityMismatch;
  }

  private shouldSample(): boolean {
    return shouldSampleParity(this.rate, this.random);
  }

  private async report(ref: MailboxRef, kind: ParityKind, diffs: ParityDiff[]): Promise<void> {
    if (diffs.length === 0) return;
    try {
      await this.onMismatch({ ref, kind, diffs });
    } catch (err) {
      console.error('[mail-store] parity onMismatch handler threw:', err instanceof Error ? err.message : err);
    }
  }

  /** `null` when this call isn't sampled (a search query, or the sample roll missed) — nothing for the caller to await. */
  sampleListThreads(
    ref: MailboxRef,
    q: ThreadListQuery,
    pgResult: ThreadPage,
    objectMailbox: Pick<MailboxStore, 'listThreads'>,
  ): Promise<void> | null {
    if (q.search) return null; // design: "searches skipped"
    if (!this.shouldSample()) return null;
    return (async () => {
      try {
        const objResult = await objectMailbox.listThreads(q);
        await this.report(ref, 'listThreads', compareThreadPage(pgResult, objResult));
      } catch (err) {
        console.error('[mail-store] parity sample (listThreads) failed:', err instanceof Error ? err.message : err);
      }
    })();
  }

  sampleStats(ref: MailboxRef, pgResult: MailboxStats, objectMailbox: Pick<MailboxStore, 'stats'>): Promise<void> | null {
    if (!this.shouldSample()) return null;
    return (async () => {
      try {
        const objResult = await objectMailbox.stats();
        await this.report(ref, 'stats', compareMailboxStats(pgResult, objResult));
      } catch (err) {
        console.error('[mail-store] parity sample (stats) failed:', err instanceof Error ? err.message : err);
      }
    })();
  }
}
