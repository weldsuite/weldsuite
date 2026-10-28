/**
 * mail-api's mail-store staff API, reached over plain HTTPS: this tool runs
 * locally against Neon, not inside a Cloudflare Worker, so it cannot address
 * a mailbox's Durable Object directly
 * (docs/plans/weldmail-mailbox-store-design.md §9 task E2). Two calls:
 *
 *  - `GET /internal/mail-store/status/all?workspaceId=` — the stored
 *    `MailStoreMode` of every mailbox in the workspace, to decide per
 *    mailbox whether `mail_messages` in the tenant Postgres database is
 *    still the full story. In `object` mode it's a best-effort secondary
 *    write that can lag or fail; in `object-only` mode it is never written
 *    at all (design §2.2's router table) — this tool cannot trust Postgres
 *    for those mailboxes.
 *  - `GET /internal/mail-store/export?workspaceId=&accountId=&cursor=` —
 *    pages that mailbox's own `exportPage` RPC directly (every row, `id`
 *    ascending). It never returns body text (the object has none to give;
 *    see that route's own header comment in mail-api), so template
 *    fingerprinting and the content screen see no content for mail read this
 *    way — `index.ts` notes that in the report when it happens.
 *
 * Same secret-plus-identity auth as the admin console
 * (`apps/workers/mail-api/src/lib/admin-auth.ts`): see README.md for the
 * three environment variables this client reads. Errors never carry a
 * response body — only the path (query string stripped) and HTTP status —
 * matching this tool's rule that nothing but ids and counts ever reaches a
 * log line.
 */

import { z } from 'zod';
import { parseAddressList } from './recipients';
import type { SentMessageRow } from './types';
import type { Window } from './tenant-queries';

/** Mirrors `@weldsuite/mail-domain/store/types`' `MailStoreMode`, kept as a local literal type so this tool doesn't pull in mail-domain's worker-side modules just for one string union. */
export type MailStoreMode = 'postgres' | 'shadow' | 'object' | 'object-only';

/** Mailboxes whose Postgres `mail_messages` isn't trustworthy on its own (design §2.2: `object`'s secondary write is best-effort, `object-only` has none). */
const OBJECT_BACKED_MODES = new Set<MailStoreMode>(['object', 'object-only']);

export function isObjectBackedMode(mode: MailStoreMode | null): boolean {
  return mode !== null && OBJECT_BACKED_MODES.has(mode);
}

export interface MailStoreAdminConfig {
  /** mail-api origin, no trailing slash, e.g. `https://mail-api-test.weldsuite.org`. */
  baseUrl: string;
  secret: string;
  adminEmail: string;
}

/** Reads `MAIL_STORE_ADMIN_URL` / `OUTBOUND_ADMIN_SECRET` / `MAIL_STORE_ADMIN_EMAIL` (README.md). Null when any is missing. */
export function mailStoreAdminConfigFromEnv(env: NodeJS.ProcessEnv): MailStoreAdminConfig | null {
  const baseUrl = env.MAIL_STORE_ADMIN_URL?.trim();
  const secret = env.OUTBOUND_ADMIN_SECRET?.trim();
  const adminEmail = env.MAIL_STORE_ADMIN_EMAIL?.trim();
  if (!baseUrl || !secret || !adminEmail) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), secret, adminEmail };
}

async function adminGet(config: MailStoreAdminConfig, path: string): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    headers: { 'x-admin-secret': config.secret, 'x-admin-email': config.adminEmail },
  });
  if (!res.ok) throw new Error(`mail-store admin request failed: HTTP ${res.status} on ${path.split('?')[0]}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Mailbox mode
// ---------------------------------------------------------------------------

const modeSchema = z.enum(['postgres', 'shadow', 'object', 'object-only']);

const statusAllSchema = z.object({
  data: z.array(
    z.union([
      z.object({ accountId: z.string(), status: z.object({ mode: modeSchema }).passthrough() }),
      z.object({ accountId: z.string(), error: z.string() }),
    ]),
  ),
});

export interface MailboxModeRow {
  accountId: string;
  mode: MailStoreMode | null;
  /** Set when the status call for this one mailbox failed; `mode` is then null. */
  error: string | null;
}

/**
 * Every mailbox's stored mode. Throws only when the whole call fails (bad
 * workspace id, auth, network) — a single mailbox's own status failure comes
 * back as one row with `error` set instead (mirroring the route's own
 * per-mailbox try/catch).
 */
export async function fetchMailboxModes(config: MailStoreAdminConfig, workspaceId: string): Promise<MailboxModeRow[]> {
  const parsed = statusAllSchema.parse(await adminGet(config, `/status/all?workspaceId=${encodeURIComponent(workspaceId)}`));
  return parsed.data.map((row) =>
    'error' in row
      ? { accountId: row.accountId, mode: null, error: row.error }
      : { accountId: row.accountId, mode: row.status.mode, error: null },
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportedMessageSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  subject: z.string().nullable(),
  to: z.unknown(),
  cc: z.unknown(),
  bcc: z.unknown(),
  inReplyTo: z.string().nullable(),
  isReply: z.boolean().nullable(),
  isForwarded: z.boolean().nullable(),
  sentDate: z.coerce.date(),
  source: z.string().nullable(),
  sendStatus: z.string().nullable(),
  isDraft: z.boolean().nullable(),
});

const exportPageSchema = z.object({
  data: z.object({ data: z.array(exportedMessageSchema), cursor: z.string().nullable() }),
});

type ExportedMessage = z.infer<typeof exportedMessageSchema>;

/**
 * The window + SENT-copy rules `tenant-queries.ts`'s `sentFilter` applies in
 * SQL, applied here client-side: the export route's own `since`/`until`
 * filter the object's `created_at`, not `sent_date`/`send_status`/`is_draft`
 * (`packages/domains/mail/src/mailbox-object/reads.ts`'s `exportPage`), so
 * this tool asks for every row (`sentOnly` only) and applies the real
 * window and status rules itself.
 */
function isSentInWindow(row: ExportedMessage, window: Window): boolean {
  if (row.source !== 'sent') return false;
  if (row.isDraft) return false;
  if (row.sendStatus && ['scheduled', 'cancelled', 'failed'].includes(row.sendStatus)) return false;
  const sentAt = row.sentDate.getTime();
  return sentAt >= window.since.getTime() && sentAt <= window.until.getTime();
}

function toSentMessageRow(row: ExportedMessage): SentMessageRow {
  return {
    id: row.id,
    accountId: row.accountId,
    sentAt: row.sentDate,
    subject: row.subject,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    inReplyTo: row.inReplyTo,
    isReply: row.isReply,
    isForwarded: row.isForwarded,
    // The object never keeps body text (see this file's header comment).
    textBody: null,
    htmlBody: null,
  };
}

/** The object's own `exportPage` page size convention (`mailbox-object/parity.ts`'s `PAGE_SIZE`) — not a new choice here. */
const EXPORT_PAGE_LIMIT = 500;

export interface MailboxRef {
  workspaceId: string;
  accountId: string;
}

/**
 * Pages one mailbox's SENT copies in the window through the export route,
 * calling `onRow` for each live or deleted row that matches the window (a
 * deleted SENT copy still counts, same as `streamSentMessages`). No body
 * text ever comes back: `row.textBody`/`row.htmlBody` are always null.
 */
export async function forEachExportedSentMessage(
  config: MailStoreAdminConfig,
  ref: MailboxRef,
  window: Window,
  onRow: (row: SentMessageRow) => void,
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const params = new URLSearchParams({
      workspaceId: ref.workspaceId,
      accountId: ref.accountId,
      sentOnly: 'true',
      limit: String(EXPORT_PAGE_LIMIT),
    });
    if (cursor) params.set('cursor', cursor);
    // eslint-disable-next-line no-await-in-loop -- each page's cursor depends on the previous page's result
    const page = exportPageSchema.parse(await adminGet(config, `/export?${params.toString()}`)).data;
    for (const raw of page.data) if (isSentInWindow(raw, window)) onRow(toSentMessageRow(raw));
    if (!page.cursor) break;
    cursor = page.cursor;
  }
}

/** Every recipient address of one mailbox's window sends, parsed exactly as `collectSentRecipients` parses them. */
export async function collectExportedSentRecipients(
  config: MailStoreAdminConfig,
  ref: MailboxRef,
  window: Window,
  into: Set<string>,
): Promise<void> {
  await forEachExportedSentMessage(config, ref, window, (row) => {
    for (const field of [row.to, row.cc, row.bcc]) for (const entry of parseAddressList(field)) into.add(entry.email);
  });
}
