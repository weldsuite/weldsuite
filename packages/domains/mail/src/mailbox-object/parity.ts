/**
 * `MailboxStoreObject`'s full parity check (design doc §4, task C4): pages
 * BOTH stores' `exportPage` (Postgres's `PostgresMailboxStore.exportPage`,
 * the object's own `./reads`' `exportPage`, called directly since this runs
 * INSIDE the object) and reports per-message differences — design's list:
 * "labels, flags, folder membership, thread key, deleted state". Folder
 * membership is a pure function of labels + deleted state
 * (`../store/model`'s `folderKeys`), so comparing the normalised label set
 * and the deleted flag already covers it; flags (`isStarred`/`isImportant`/
 * `isTrash`/`isSpam`) are folded into that same label set via
 * `../store/model`'s `normalizeLegacy`, applied identically to BOTH sides —
 * this is also exactly how the intended "object adds IMPORTANT for AI
 * categories" difference (`writes-extra.ts`'s own comment on `categories`)
 * disappears: Postgres's `isImportant` column is true either way, so
 * `normalizeLegacy` adds IMPORTANT to the Postgres side's comparison set too.
 *
 * Other normalised-away differences (design task description):
 *  - **Search is never compared** — neither side's `exportPage` returns FTS
 *    state to compare in the first place.
 *  - **Bodies are compared by presence, not content.** The object's
 *    `exportPage` never returns body text (`./reads.ts`'s own documented
 *    contract), so presence comes from the `messages.body_bits` column via a
 *    small side query instead of `exportPage`'s own shape; Postgres's
 *    presence is just `Boolean(textBody)`/`Boolean(htmlBody)` on the already
 *    `{bodies: true}` rows `exportPage` returns.
 *  - **Legacy-only columns** (`mailcowMessageId`, `unsnoozeTriggerRunId`,
 *    `sendProvider`, `mailgunMessageId`, read/delivery receipts, `openedAt`,
 *    `isEncrypted`/`isSigned`) are never compared: `./sql.ts`'s `mapMessageRow`
 *    already documents them as dropped from this schema, so there is nothing
 *    on the object side to compare them against.
 *
 * **Pagination.** Both `exportPage` implementations order by `id` ascending
 * and accept an `id` cursor, so this is a standard sorted merge-join: an id
 * only on the Postgres side is `missing`; only on the object side is `extra`;
 * on both sides, compare. One call processes up to `options.maxRows` rows
 * (bounded, synchronous — unlike backfill this is admin-triggered, not
 * alarm-paged; design task C4 calls it "alarm-paged", but an admin-bounded
 * loop is the pragmatic equivalent for an operator-triggered diagnostic, and
 * is far simpler to make deterministic in tests). When the budget is hit
 * before both sides are exhausted, the result carries `done: false` and a
 * `cursor` the caller (the admin route) passes back in to continue — the
 * cursor is the SAME value fed to both sides' next `exportPage` call, chosen
 * as the smaller of "last id this round fully consumed from Postgres" and
 * "...from the object", which never skips a row on resume at the cost of
 * occasionally re-comparing a handful of ids spanning the boundary; the
 * final report dedupes `missing`/`extra`/`different` by id, so a resume never
 * double-reports.
 *
 * **Repair** (`options.repair`, design: "in shadow, `applyPgRow`"): for every
 * `missing` or `different` id this call found THIS round, re-fetch that row's
 * full Postgres state (a plain Drizzle select, not `exportPage` — see below)
 * and run it through `./backfill`'s `applyPgRow`/`ensureBodiesInR2`, the same
 * insert-or-LWW-merge path backfill itself uses. `extra` ids are never
 * touched: an object-only row ahead of Postgres is exactly what `object` mode
 * expects while Postgres hasn't caught up yet (design: "in object mode,
 * `pg_drift`" is the repair path for that direction, not this one).
 *
 * `exportPage`'s `MailMessageRecord` (what the merge-join itself compares)
 * is not the same shape `applyPgRow` needs (a raw Drizzle `MailMessage` row,
 * for its own `rawMessage`/attachment handling) — repair re-fetches the
 * exact rows to repair directly rather than reusing the scan's own rows, so
 * `applyPgRow` never sees anything but the real row shape it already handles
 * in backfill.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';
import type { MailAttachment } from '@weldsuite/db/schema/mail-attachments';
import type { MailMessage } from '@weldsuite/db/schema/mail-messages';
import { normalizeLegacy } from '../store/model';
import { PostgresMailboxStore } from '../store/postgres/mailbox-store';
import type { MailboxRef, MailMessageRecord } from '../store/types';
import { applyPgRow, defaultTenantDbReader, ensureBodiesInR2, type BackfillEnv } from './backfill';
import * as reads from './reads';
import { placeholders } from './sql';
import type { WritableStorage } from './writes';

const { mailAttachments, mailMessages } = schema;

export type ParityEnv = BackfillEnv;

const PAGE_SIZE = 500;
const DEFAULT_MAX_ROWS = 5_000;
const META_KEY = 'last_parity';

export interface ParityRowSnapshot {
  threadKey: string;
  labels: string[];
  deleted: boolean;
  hasHtml: boolean;
  hasText: boolean;
}

export type ParityDiffReason = 'labels' | 'deleted' | 'threadKey' | 'bodyPresence';

export interface ParityDiff {
  id: string;
  reasons: ParityDiffReason[];
  postgres: ParityRowSnapshot;
  object: ParityRowSnapshot;
}

export interface ParityReport {
  startedAt: number;
  finishedAt: number | null;
  repaired: boolean;
  scanned: number;
  missing: string[];
  extra: string[];
  different: ParityDiff[];
  cursor: string | null;
  done: boolean;
}

export interface RunParityOptions {
  /** Resume point from a previous (incomplete) call; omit to start from the top. */
  cursor?: string | null;
  /** Bounds this call's work; default 5,000 rows. */
  maxRows?: number;
  /** Re-apply Postgres's version for every `missing`/`different` id this call found. */
  repair?: boolean;
}

function getMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0];
  return row ? row.value : null;
}

function setMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

export function lastParityReport(sql: SqlStorage): ParityReport | null {
  const raw = getMeta(sql, META_KEY);
  return raw === null ? null : (JSON.parse(raw) as ParityReport);
}

function canonicalLabels(input: {
  labels: readonly string[] | null | undefined;
  isStarred?: boolean | null;
  isImportant?: boolean | null;
  isTrash?: boolean | null;
  isSpam?: boolean | null;
}): string[] {
  return normalizeLegacy(input).sort();
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** `messages.body_bits` for a set of object ids, in one query (no R2 calls — see the file comment above). */
function objectBodyBits(sql: SqlStorage, ids: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  if (ids.length === 0) return map;
  for (const row of sql
    .exec<{ id: string; body_bits: number }>(`SELECT id, body_bits FROM messages WHERE id IN (${placeholders(ids.length)})`, ...ids)
    .toArray()) {
    map.set(row.id, row.body_bits);
  }
  return map;
}

function snapshotPostgres(row: MailMessageRecord): ParityRowSnapshot {
  return {
    threadKey: row.threadKey,
    labels: canonicalLabels({ labels: row.labels, isStarred: row.isStarred, isImportant: row.isImportant, isTrash: row.isTrash, isSpam: row.isSpam }),
    deleted: Boolean(row.deletedAt),
    hasHtml: Boolean(row.htmlBody),
    hasText: Boolean(row.textBody),
  };
}

function snapshotObject(row: MailMessageRecord, bits: number | undefined): ParityRowSnapshot {
  return {
    threadKey: row.threadKey,
    // The object's own `labels_json` is already canonical, but re-folding
    // costs nothing and guarantees the exact same comparison function runs
    // on both sides.
    labels: canonicalLabels({ labels: row.labels, isStarred: row.isStarred, isImportant: row.isImportant, isTrash: row.isTrash, isSpam: row.isSpam }),
    deleted: Boolean(row.deletedAt),
    hasHtml: Boolean((bits ?? 0) & 1),
    hasText: Boolean((bits ?? 0) & 2),
  };
}

function diffOf(id: string, pg: ParityRowSnapshot, obj: ParityRowSnapshot): ParityDiff | null {
  const reasons: ParityDiffReason[] = [];
  if (!sameLabels(pg.labels, obj.labels)) reasons.push('labels');
  if (pg.deleted !== obj.deleted) reasons.push('deleted');
  if (pg.threadKey !== obj.threadKey) reasons.push('threadKey');
  if (pg.hasHtml !== obj.hasHtml || pg.hasText !== obj.hasText) reasons.push('bodyPresence');
  return reasons.length > 0 ? { id, reasons, postgres: pg, object: obj } : null;
}

// ---------------------------------------------------------------------------
// The merge-join scan
// ---------------------------------------------------------------------------

async function runScan(
  storage: WritableStorage,
  db: Database,
  ref: MailboxRef,
  options: RunParityOptions,
): Promise<{ scanned: number; missing: string[]; extra: string[]; different: ParityDiff[]; cursor: string | null; done: boolean }> {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const postgresStore = new PostgresMailboxStore(db, ref);

  let pgCursor = options.cursor ?? undefined;
  let objCursor = options.cursor ?? undefined;
  let pgDone = false;
  let objDone = false;
  let scanned = 0;
  /**
   * Whether the LAST round processed ended with unconsumed rows still sitting
   * in one of its two fetched pages. `pgDone`/`objDone` only mean "no further
   * PAGE to fetch" — a page can still have leftover items when the row
   * budget (`maxRows`) cuts the round off mid-page, even on what happens to
   * be each side's very last page. Only `pgDone && objDone && !leftover` is
   * truly "nothing left anywhere".
   */
  let leftover = false;
  const missing: string[] = [];
  const extra: string[] = [];
  const different: ParityDiff[] = [];

  while (scanned < maxRows && !(pgDone && objDone)) {
    const pgPage = pgDone ? { data: [] as MailMessageRecord[], cursor: null } : await postgresStore.exportPage({ cursor: pgCursor, limit: PAGE_SIZE });
    const objPage = objDone ? { data: [] as MailMessageRecord[], cursor: null } : reads.exportPage(storage.sql, ref, { cursor: objCursor, limit: PAGE_SIZE });
    if (pgPage.cursor === null) pgDone = true;
    if (objPage.cursor === null) objDone = true;
    if (pgPage.data.length === 0 && objPage.data.length === 0) break;

    const bits = objectBodyBits(storage.sql, objPage.data.map((r) => r.id));

    let i = 0;
    let j = 0;
    while (i < pgPage.data.length && j < objPage.data.length && scanned < maxRows) {
      const p = pgPage.data[i]!;
      const o = objPage.data[j]!;
      if (p.id === o.id) {
        const diff = diffOf(p.id, snapshotPostgres(p), snapshotObject(o, bits.get(o.id)));
        if (diff) different.push(diff);
        i++;
        j++;
      } else if (p.id < o.id) {
        missing.push(p.id);
        i++;
      } else {
        extra.push(o.id);
        j++;
      }
      scanned++;
    }
    // A leftover tail in one page only means something once the OTHER side
    // is known to have no more rows at all (otherwise it might still catch
    // up on its own next page) — see the file comment's pagination note.
    while (i < pgPage.data.length && objDone && scanned < maxRows) {
      missing.push(pgPage.data[i]!.id);
      i++;
      scanned++;
    }
    while (j < objPage.data.length && pgDone && scanned < maxRows) {
      extra.push(objPage.data[j]!.id);
      j++;
      scanned++;
    }

    // A leftover tail can remain here for two different reasons: (a) one
    // side's page ran dry before the other's but isn't globally `*Done` yet
    // (the drain loops above correctly left it alone, pending its own next
    // page), or (b) the row budget (`maxRows`) cut the round off mid-page on
    // what happens to be each side's last page. Either way, `commonCursor` —
    // the smaller of the two prefixes actually consumed THIS round — is safe
    // to resume from: the next round (whether triggered by this same call's
    // outer loop for reason (a), or by the caller passing this result's
    // `cursor` back in for reason (b)) re-fetches both sides from a point
    // already compared up to, in lockstep, making strictly forward progress.
    // Not an infinite loop, and never skips a row; the only cost is
    // occasionally re-comparing a handful of ids spanning the gap, which the
    // final dedup absorbs.
    leftover = i < pgPage.data.length || j < objPage.data.length;
    const lastPg = i > 0 ? pgPage.data[i - 1]!.id : null;
    const lastObj = j > 0 ? objPage.data[j - 1]!.id : null;
    const commonCursor = lastPg !== null && lastObj !== null ? (lastPg < lastObj ? lastPg : lastObj) : (lastPg ?? lastObj ?? pgCursor ?? objCursor ?? null);
    pgCursor = commonCursor ?? undefined;
    objCursor = commonCursor ?? undefined;
  }

  // Truly done only once both sides have no further pages AND the last round
  // processed left nothing unconsumed in either fetched page (see `leftover`
  // above — reason (b) there is exactly the case this guards against: the
  // budget running out mid-page on what happens to be the last page of one or
  // both sides).
  const done = pgDone && objDone && !leftover;
  return {
    scanned,
    missing: [...new Set(missing)],
    extra: [...new Set(extra)],
    different: [...new Map(different.map((d) => [d.id, d])).values()],
    cursor: done ? null : (pgCursor ?? objCursor ?? null),
    done,
  };
}

// ---------------------------------------------------------------------------
// Repair (design: "in shadow, applyPgRow")
// ---------------------------------------------------------------------------

async function repairRows(storage: WritableStorage, env: ParityEnv, db: Database, ref: MailboxRef, ids: readonly string[], now: number): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.select().from(mailMessages).where(and(eq(mailMessages.accountId, ref.accountId), inArray(mailMessages.id, [...ids])));
  const attachmentRows =
    rows.length === 0
      ? []
      : await db.select().from(mailAttachments).where(and(inArray(mailAttachments.messageId, rows.map((r) => r.id)), isNull(mailAttachments.deletedAt)));
  const attachmentsByMessage = new Map<string, MailAttachment[]>();
  for (const a of attachmentRows) {
    const list = attachmentsByMessage.get(a.messageId) ?? [];
    list.push(a);
    attachmentsByMessage.set(a.messageId, list);
  }
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop -- repair runs over a bounded id list (this call's own missing+different ids), sequential R2 checks are simplest to reason about here
    const bodies = await ensureBodiesInR2(env.MAIL_STORAGE, ref, row);
    applyPgRow(storage, ref, row, attachmentsByMessage.get(row.id) ?? [], bodies, now);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** `MailboxStoreObject.runParity` (RPC, design task C4). See the file comment above for pagination and repair semantics. */
export async function runParity(storage: WritableStorage, env: ParityEnv, ref: MailboxRef, options: RunParityOptions = {}): Promise<ParityReport> {
  const startedAt = Date.now();
  const reader = env.tenantDbReader ?? defaultTenantDbReader(env);
  const db = await reader(ref.workspaceId);

  const scan = await runScan(storage, db, ref, options);

  if (options.repair) {
    const toRepair = [...new Set([...scan.missing, ...scan.different.map((d) => d.id)])];
    await repairRows(storage, env, db, ref, toRepair, startedAt);
  }

  const report: ParityReport = {
    startedAt,
    finishedAt: scan.done ? Date.now() : null,
    repaired: Boolean(options.repair),
    scanned: scan.scanned,
    missing: scan.missing,
    extra: scan.extra,
    different: scan.different,
    cursor: scan.cursor,
    done: scan.done,
  };
  setMeta(storage.sql, META_KEY, JSON.stringify(report));
  console.log(
    '[mailbox-store] mailbox_parity:',
    `ref=${ref.workspaceId}:${ref.accountId} scanned=${report.scanned} missing=${report.missing.length} extra=${report.extra.length} different=${report.different.length} done=${report.done} repaired=${report.repaired}`,
  );
  return report;
}
