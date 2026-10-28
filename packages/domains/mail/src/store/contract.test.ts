/**
 * Contract suite (design task C5, docs/plans/weldmail-mailbox-store-design.md
 * §9): the SAME scenarios, built only through `MailboxStore`'s own write API
 * (`apply`/`applyBatch`), run against `PostgresMailboxStore` (task B4, pglite)
 * and `ObjectMailboxStore` (task C2, the real `mailbox-object/{reads,writes}.ts`
 * logic via the fake stub — not a mock). Every scenario in the first
 * `describe.each` block below asserts the SAME literal expectation against
 * both backends, so two backends matching the same expectation have,
 * transitively, matched each other.
 *
 * Scenarios are ported from this package's pglite suites: `threads-listing`,
 * `labels-locations`, `labels-archive`, `messages-stats`, `messages-spam`,
 * `thread-filters-counts`, `thread-ops` — adapted from calling `../threads`/
 * `../messages`/`../labels`/`../thread-ops` directly to going through
 * `MailboxOp`s instead.
 *
 * Known, intentional differences (normalised below, not asserted equal):
 * - search semantics (design decision 3) — `search` is never used in any
 *   assertion here;
 * - the object adds the `IMPORTANT` label for an AI `categories` op with
 *   `important: true`; Postgres only sets the `isImportant` column. Folder
 *   membership (what actually matters to a caller) is asserted equal; the
 *   raw `labels` array is not.
 * - `stats().labels` has no zero-row for an empty custom label in the
 *   object (it has no `mail_labels` table to zero-fill from); Postgres
 *   zero-fills every label name that exists as a row — see the dedicated
 *   test below, which checks the shared, registry-independent
 *   `labelCounts(keys)` contract instead.
 * - message bodies are compared by presence (non-null vs null), not by
 *   exact text.
 * - legacy-only Postgres columns (`mailcowMessageId`, the unsnooze
 *   `triggerRunId`) have no field on `IngestMessage`/`MailboxOp` that can
 *   set them, so no scenario here can reach them on either backend — they
 *   are simply unreachable through the shared op surface, not exercised.
 *
 * Custom (non-system) label scenarios in the shared block below use
 * all-lowercase label names (`'invoices'`, `'clients'`, …) on purpose: a
 * custom label's *registered* name lives in the Postgres-only `mail_labels`
 * table (design: "P, served from the directory in object modes"), which is
 * outside the `MailboxStore`/`MailboxOp` contract entirely — task C5 tests
 * the store, not the label registry. `PostgresMailboxStore.listThreads`
 * resolves a label slug against `mail_labels` (via `resolveCustomLabelNames`)
 * AND falls back to an exact, case-sensitive match against the slug itself
 * when no such row exists; keeping every custom label's stored casing
 * identical to its queried slug exercises that fallback on both backends
 * without needing a `mail_labels` row (which the object has no use for at
 * all). The scenarios that specifically exercise case-insensitive slug
 * resolution (`listThreads`, and `labelCounts`/`stats()` since their own
 * fix) register a `mail_labels` row for Postgres via the `ensureLabel`
 * helper, matching how a real caller/router would ensure the label exists
 * before asking a store for its folder or its counts.
 *
 * Four of the five "other differences" originally found while writing this
 * suite (snooze.wake's `OpResult`, `label.delete` casing, `labelCounts`/
 * `stats()` custom-label casing, `folder.read`'s `more` flag) were fixed in
 * `store/postgres/mailbox-store.ts` and its helpers (`../../labels.ts`,
 * `../../snooze.ts`, `../../thread-ops.ts`) and now live as ordinary, shared
 * assertions in the first `describe.each` block instead of here. The one
 * difference NOT fixed by that pass (wake-on-read; an object-side fix comes
 * later) is still a standalone, non-parameterised `it.fails` in the final
 * `describe` block below, with a comment describing the exact observed
 * behaviour.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema } from '@weldsuite/worker-kit/db';
import type { Database } from '@weldsuite/worker-kit/db';

import { PostgresMailboxStore } from './postgres/mailbox-store';
import { ObjectMailboxStore, type ObjectMailboxStoreEnv } from './object/mailbox-store';
import { createFakeMailboxNamespace } from './object/testing/fake-env';
import { createMailLabel } from '../labels';
import type { IngestMessage, MailboxStore, ThreadCursor } from './types';

const { mailAccounts } = schema;

type BackendName = 'postgres' | 'object';

const BACKENDS: { name: BackendName }[] = [{ name: 'postgres' }, { name: 'object' }];

let pgDb: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  pgDb = handle.db;
}, 60_000);

// ---------------------------------------------------------------------------
// Seeding helpers — shared verbatim across both `describe.each` bodies so the
// exact same ops reach both stores.
// ---------------------------------------------------------------------------

let msgSeq = 0;
let accountSeq = 0;
/** A fresh id, unique across the whole file (both backends share counters, so ids never collide even though `pgDb` is one shared database across every postgres-backend test). */
function nextId(prefix: string): string {
  msgSeq += 1;
  return `${prefix}_${msgSeq}`;
}

function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  const id = overrides.id ?? nextId('cmsg');
  return {
    id,
    source: 'inbound',
    rfcMessageId: `${id}@contract.test`,
    threadId: null,
    from: { email: 'sender@example.com', name: 'Sender' },
    to: [{ email: 'me@contract.test' }],
    subject: 'Contract test',
    preview: 'preview text',
    sentAt: 1_000,
    receivedAt: 1_000,
    createdAt: 1_000,
    isRead: false,
    labels: ['INBOX'],
    isSpam: false,
    isReply: false,
    attachments: [],
    ...overrides,
  };
}

async function newPostgresStore(): Promise<{ store: MailboxStore; accountId: string }> {
  accountSeq += 1;
  const accountId = `acc_contract_pg_${accountSeq}`;
  await pgDb.insert(mailAccounts).values({
    id: accountId,
    name: 'Contract',
    email: `${accountId}@test.dev`,
    isShared: true,
  });
  return { store: new PostgresMailboxStore(pgDb, { workspaceId: 'ws_contract', accountId }), accountId };
}

function newObjectStore(): { store: MailboxStore; accountId: string } {
  accountSeq += 1;
  const accountId = `acc_contract_obj_${accountSeq}`;
  const { namespace } = createFakeMailboxNamespace();
  const env: ObjectMailboxStoreEnv = { MAILBOX_STORE: namespace, MAIL_STORAGE: createMemoryR2() };
  return { store: new ObjectMailboxStore(env, { workspaceId: 'ws_contract', accountId }), accountId };
}

describe.each(BACKENDS)('mailbox store contract: $name', ({ name }) => {
  let currentAccountId = '';

  async function freshStore(): Promise<MailboxStore> {
    const built = name === 'postgres' ? await newPostgresStore() : newObjectStore();
    currentAccountId = built.accountId;
    return built.store;
  }

  /** Registers a custom label's canonical name — only meaningful on Postgres (`mail_labels`); a no-op on the object, which has no such table (design §6: label definitions live in the KV directory in object modes, outside this store's contract). */
  async function ensureLabel(accountLabelName: string): Promise<void> {
    if (name !== 'postgres') return;
    await createMailLabel(pgDb, { accountId: currentAccountId, name: accountLabelName });
  }

  async function ingest(store: MailboxStore, overrides: Partial<IngestMessage> = {}, at?: number) {
    const message = makeIngest(overrides);
    const result = await store.apply({ kind: 'ingest', message }, at ?? message.sentAt);
    return { id: message.id, result };
  }

  async function latestIdsIn(store: MailboxStore, labelSlug: string, extra: Record<string, unknown> = {}) {
    const page = await store.listThreads({ labelSlug, pageSize: 50, ...extra });
    expect(page.totalCount).toBe(page.threads.length);
    return page.threads.map((t) => t.latestMessageId);
  }

  async function threadKeysIn(store: MailboxStore, labelSlug: string, extra: Record<string, unknown> = {}) {
    const page = await store.listThreads({ labelSlug, pageSize: 50, ...extra });
    expect(page.totalCount).toBe(page.threads.length);
    return page.threads.map((t) => t.threadId);
  }

  // -------------------------------------------------------------------------
  // Thread listing: folder isolation, ordering, pagination
  // -------------------------------------------------------------------------

  describe('thread listing', () => {
    it('keeps trash, spam and starred isolated from the inbox and from each other', async () => {
      const store = await freshStore();
      const { id: kept } = await ingest(store, { labels: ['INBOX'] });
      const { id: trashed } = await ingest(store, { labels: ['INBOX', 'TRASH'] });
      const { id: spam } = await ingest(store, { labels: ['INBOX', 'SPAM', 'STARRED'] });

      expect(await latestIdsIn(store, 'inbox')).toEqual([kept]);
      expect(await latestIdsIn(store, 'all')).toEqual([kept]);
      expect(await latestIdsIn(store, 'starred')).toEqual([]);
      expect(await latestIdsIn(store, 'trash')).toEqual([trashed]);
      expect(await latestIdsIn(store, 'spam')).toEqual([spam]);
    });

    it('a custom label folder matches whatever casing the slug is requested in, once registered', async () => {
      const store = await freshStore();
      await ensureLabel('Invoices');
      const { id } = await ingest(store, { labels: ['INBOX', 'Invoices'] });

      for (const slug of ['invoices', 'Invoices', 'INVOICES']) {
        expect(await latestIdsIn(store, slug)).toEqual([id]);
      }
    });

    it('a star or important flag set through flags shows in its own folder', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX'] });

      await store.apply({ kind: 'flags', ids: [id], patch: { isStarred: true }, semantics: 'single' }, 2_000);
      expect(await latestIdsIn(store, 'starred')).toEqual([id]);

      await store.apply({ kind: 'flags', ids: [id], patch: { isImportant: true }, semantics: 'single' }, 3_000);
      expect(await latestIdsIn(store, 'important')).toEqual([id]);
    });

    it('orders a folder by its newest live message; a reply in another folder lifts the thread, a soft delete drops it back', async () => {
      const store = await freshStore();
      const older = 'thread_older';
      const newer = 'thread_newer';
      await ingest(store, { threadId: older, labels: ['INBOX'], sentAt: 1_000, receivedAt: 1_000 }, 1_000);
      await ingest(store, { threadId: newer, labels: ['INBOX'], sentAt: 2_000, receivedAt: 2_000 }, 2_000);

      expect(await threadKeysIn(store, 'inbox')).toEqual([newer, older]);

      // A sent reply (not itself INBOX) lifts the older conversation to the top.
      const { id: reply } = await ingest(
        store,
        { threadId: older, source: 'sent', labels: ['SENT'], sentAt: 3_000, receivedAt: null },
        3_000,
      );
      expect(await threadKeysIn(store, 'inbox')).toEqual([older, newer]);

      // A deleted message does not count towards the thread's date any more.
      await store.apply({ kind: 'delete', ids: [reply] }, 4_000);
      expect(await threadKeysIn(store, 'inbox')).toEqual([newer, older]);
    });

    it('a thread cursor page continues correctly across the whole list', async () => {
      const store = await freshStore();
      for (let i = 0; i < 3; i++) {
        await ingest(
          store,
          { threadId: `thread_cursor_${i}`, labels: ['INBOX'], sentAt: 1_000 + i * 1_000, receivedAt: 1_000 + i * 1_000 },
          1_000 + i * 1_000,
        );
      }

      const seen: string[] = [];
      let cursor: ThreadCursor | null | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await store.listThreads({ labelSlug: 'inbox', pageSize: 1, cursor });
        if (page.threads.length === 0) break;
        seen.push(page.threads[0]!.threadId);
        cursor = page.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toEqual(['thread_cursor_2', 'thread_cursor_1', 'thread_cursor_0']);
    });

    it('applies the From / Subject / attachment filters inside a folder', async () => {
      const store = await freshStore();
      const { id: match } = await ingest(store, {
        labels: ['INBOX'],
        subject: 'Invoice 42',
        from: { email: 'billing@acme.example', name: 'Acme Billing' },
        // `messageId` here is ignored by both `applyIngest`s — they always
        // file the attachment under the message actually being ingested —
        // but `AttachmentInput` requires the field structurally.
        attachments: [{ id: nextId('att'), messageId: 'ignored', fileName: 'invoice.pdf', size: 10 }],
      });
      await ingest(store, { labels: ['INBOX'], subject: 'Invoice 43' });
      await ingest(store, {
        labels: ['ARCHIVE'],
        subject: 'Invoice 41',
        from: { email: 'billing@acme.example' },
        attachments: [{ id: nextId('att'), messageId: 'ignored', fileName: 'invoice.pdf', size: 10 }],
      });

      expect(await latestIdsIn(store, 'inbox', { from: 'acme', subject: 'invoice', hasAttachment: true })).toEqual([
        match,
      ]);
    });

    it('a "doesn\'t have" word rules out the whole thread, any word matching', async () => {
      const store = await freshStore();
      const { id: keep } = await ingest(store, { threadId: 'thread_kept', labels: ['INBOX'], subject: 'Lunch' });
      await ingest(store, { threadId: 'thread_news', labels: ['INBOX'], subject: 'Newsletter' });
      await ingest(store, { threadId: 'thread_inv', labels: ['INBOX'], subject: 'Invoice time' });

      expect(await latestIdsIn(store, 'inbox', { excludeWords: 'newsletter invoice' })).toEqual([keep]);
    });
  });

  // -------------------------------------------------------------------------
  // Stats and label counts
  // -------------------------------------------------------------------------

  describe('stats and label counts', () => {
    it('returns zero stats for an empty mailbox', async () => {
      const store = await freshStore();
      const stats = await store.stats();
      const { labels: _labels, ...scalars } = stats;
      expect(Object.values(scalars).every((n) => n === 0)).toBe(true);
    });

    it('counts every sidebar badge the same combination the 2026-10-04 QA run checked', async () => {
      const store = await freshStore();
      await ingest(store, { labels: ['INBOX'] });
      await ingest(store, { labels: ['INBOX'], isRead: true });
      await ingest(store, { labels: ['INBOX', 'STARRED'], isRead: true });
      await ingest(store, { labels: ['INBOX', 'IMPORTANT'] });
      await ingest(store, { labels: ['ARCHIVE'] });
      await ingest(store, { labels: ['TRASH', 'STARRED'] });
      await ingest(store, { labels: ['SPAM'] });
      await ingest(store, { labels: ['SPAM'], isRead: true });
      await ingest(store, { labels: ['SNOOZED'], isRead: true });
      await ingest(store, { source: 'sent', labels: ['SENT', 'SCHEDULED'], isRead: true, sendStatus: 'scheduled' });
      await ingest(store, { source: 'sent', labels: ['SENT'], isRead: true, sendStatus: 'sent' });
      await store.apply({
        kind: 'draft.create',
        draft: { id: nextId('draft'), accountId: currentAccountId, subject: 'Draft one' },
      });
      await store.apply({
        kind: 'draft.create',
        draft: { id: nextId('draft'), accountId: currentAccountId, subject: 'Draft two' },
      });

      const stats = await store.stats();
      const { labels: _labels, ...scalars } = stats;
      expect(scalars).toEqual({
        total: 11,
        unread: 5,
        inboxUnread: 2,
        starred: 1,
        importantUnread: 1,
        sentUnread: 0,
        archiveUnread: 1,
        trashUnread: 1,
        spam: 2,
        snoozed: 1,
        scheduled: 1,
        drafts: 2,
      });
    });

    it('label counts match the folder listing — trashed/spammed/archived mail stays out', async () => {
      const store = await freshStore();
      await ingest(store, { labels: ['INBOX', 'invoices'] });
      // Not inbox, not archive: still counts for the label.
      await ingest(store, { source: 'sent', labels: ['SENT', 'invoices'] });
      await ingest(store, { labels: ['TRASH', 'invoices'] });
      await ingest(store, { labels: ['SPAM', 'invoices'] });
      await ingest(store, { labels: ['ARCHIVE', 'invoices'] });
      const { id: deleted } = await ingest(store, { labels: ['INBOX', 'invoices'] });
      await store.apply({ kind: 'delete', ids: [deleted] });

      const listed = await latestIdsIn(store, 'invoices');
      expect(listed).toHaveLength(2);
      const counts = await store.labelCounts(['invoices']);
      expect(counts.invoices).toEqual({ messages: 2, unread: 2, threads: 2 });
    });

    it('archiving a thread drops it from a custom label folder and its badge, without losing the label', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { threadId: 'thread_clients', labels: ['INBOX', 'clients'] });

      expect(await latestIdsIn(store, 'clients')).toEqual([id]);
      expect((await store.labelCounts(['clients'])).clients).toEqual({ messages: 1, unread: 1, threads: 1 });

      await store.apply({ kind: 'thread.label', threadKey: 'thread_clients', label: 'ARCHIVE', action: 'add' }, 2_000);

      expect(await latestIdsIn(store, 'clients')).toEqual([]);
      expect((await store.labelCounts(['clients'])).clients).toEqual({ messages: 0, unread: 0, threads: 0 });
      // The label itself survives — it still shows in the system folder and the archive.
      expect(await latestIdsIn(store, 'archive')).toEqual([id]);

      await store.apply({ kind: 'thread.label', threadKey: 'thread_clients', label: 'INBOX', action: 'add' }, 3_000);
      expect(await latestIdsIn(store, 'clients')).toEqual([id]);
    });

    it('labelCounts(keys) zero-fills a key with no messages on both backends', async () => {
      const store = await freshStore();
      expect(await store.labelCounts(['neverused'])).toEqual({ neverused: { messages: 0, unread: 0, threads: 0 } });
    });

    it('labelCounts/stats agree with listThreads for a case-differing custom label', async () => {
      const store = await freshStore();
      await ensureLabel('Invoices');
      const { id } = await ingest(store, { labels: ['INBOX', 'Invoices'] });

      expect(await latestIdsIn(store, 'invoices')).toEqual([id]);

      const counts = await store.labelCounts(['invoices']);
      expect(counts.invoices).toEqual({ messages: 1, unread: 1, threads: 1 });

      const stats = await store.stats();
      expect(stats.labels.invoices).toEqual({ messages: 1, unread: 1, threads: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Moves and restores
  // -------------------------------------------------------------------------

  describe('moves and restores', () => {
    it('the move op never puts outgoing mail (SENT) back in the inbox when restored', async () => {
      const store = await freshStore();
      const { id: received } = await ingest(store, { labels: ['TRASH'] });
      const { id: sent } = await ingest(store, { source: 'sent', labels: ['SENT', 'TRASH'] });

      await store.apply({ kind: 'move', ids: [received, sent], location: 'INBOX' }, 2_000);

      expect(await latestIdsIn(store, 'inbox')).toEqual([received]);
      expect(await latestIdsIn(store, 'sent')).toEqual([sent]);
      expect(await latestIdsIn(store, 'trash')).toEqual([]);
    });

    it('trashing twice leaves a single TRASH label', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX'] });

      await store.apply({ kind: 'move', ids: [id], location: 'TRASH' }, 2_000);
      await store.apply({ kind: 'move', ids: [id], location: 'TRASH' }, 3_000);

      expect(await latestIdsIn(store, 'trash')).toEqual([id]);
      expect(await latestIdsIn(store, 'inbox')).toEqual([]);
    });

    it('bulk-semantics flags untrash never re-adds INBOX to outgoing mail', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { source: 'sent', labels: ['SENT', 'TRASH'] });

      await store.apply({ kind: 'flags', ids: [id], patch: { isTrash: false }, semantics: 'bulk' }, 2_000);

      expect(await latestIdsIn(store, 'sent')).toEqual([id]);
      expect(await latestIdsIn(store, 'inbox')).toEqual([]);
      expect(await latestIdsIn(store, 'trash')).toEqual([]);
    });

    // Explicit check requested for this task: a single-message untrash
    // (`flags` op, `semantics: 'single'`) goes through the same
    // `leaveLocation` rule `updateMessage` always used, which does not know
    // about outgoing mail (`OUTGOING_LABELS`) the way `moveMessagesToLocation`
    // (bulk) does. `mailbox-object/writes.ts`'s `computeFlagPatch` documents
    // replicating this on purpose ("'single' mirrors updateMessage's
    // labelsForFlagPatch ... 'bulk' mirrors bulkUpdateMessages's trash/restore").
    // Both backends therefore reproduce the SAME pre-existing Postgres quirk
    // bug-for-bug: a single-message untrash DOES put a SENT message back in
    // the inbox, unlike the bulk path. This is NOT a cross-store divergence —
    // verified identical on both backends below.
    it('single-semantics flags untrash restores INBOX even for outgoing mail (both backends agree, intentionally)', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { source: 'sent', labels: ['SENT', 'TRASH'] });

      await store.apply({ kind: 'flags', ids: [id], patch: { isTrash: false }, semantics: 'single' }, 2_000);

      // Both backends: INBOX comes back even though the mail is SENT.
      expect(await latestIdsIn(store, 'inbox')).toEqual([id]);
      expect(await latestIdsIn(store, 'sent')).toEqual([id]);
    });

    it('untrashing a non-outgoing message always restores INBOX, single or bulk', async () => {
      const store = await freshStore();
      const { id: single } = await ingest(store, { labels: ['TRASH'] });
      const { id: bulk } = await ingest(store, { labels: ['TRASH'] });

      await store.apply({ kind: 'flags', ids: [single], patch: { isTrash: false }, semantics: 'single' }, 2_000);
      await store.apply({ kind: 'flags', ids: [bulk], patch: { isTrash: false }, semantics: 'bulk' }, 2_000);

      expect(await latestIdsIn(store, 'inbox')).toEqual(expect.arrayContaining([single, bulk]));
    });

    it('not-spam on a trashed message does not re-add INBOX (leaveLocation sees TRASH first)', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['TRASH', 'SPAM'] });

      await store.apply({ kind: 'flags', ids: [id], patch: { isSpam: false }, semantics: 'single' }, 2_000);

      expect(await latestIdsIn(store, 'trash')).toEqual([id]);
      expect(await latestIdsIn(store, 'inbox')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Snooze / unsnooze / wake
  //
  // `until`/`now` values are offsets from the real wall clock (`Date.now()`),
  // never small fixed numbers: Postgres auto-wakes an overdue snooze as a
  // side effect of a plain read (`listThreads` et al, same rule as the
  // pre-split `threadListScope`'s `buildWake`), which compares against the
  // REAL clock, not the `at` passed to `apply`. A snooze meant to still be
  // pending by the time this test reads it back must stay in the real
  // future; see the dedicated divergence test at the bottom of this file for
  // what happens when it doesn't.
  // -------------------------------------------------------------------------

  describe('snooze, unsnooze, wake', () => {
    const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60_000;

    it('snoozing takes mail out of the inbox and into Snoozed, marking it read', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX'] });

      await store.apply({ kind: 'snooze', id, until: FAR_FUTURE }, 2_000);

      expect(await latestIdsIn(store, 'snoozed')).toEqual([id]);
      expect(await latestIdsIn(store, 'inbox')).toEqual([]);
    });

    it('unsnoozing (manual) returns mail to the inbox, unread', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX'] });
      await store.apply({ kind: 'snooze', id, until: FAR_FUTURE }, 2_000);

      await store.apply({ kind: 'unsnooze', id }, 3_000);

      expect(await latestIdsIn(store, 'inbox')).toEqual([id]);
      expect(await latestIdsIn(store, 'snoozed')).toEqual([]);
    });

    it('snooze.wake wakes only mail whose time has passed, leaving the rest snoozed', async () => {
      const store = await freshStore();
      const { id: due } = await ingest(store, { labels: ['INBOX'] });
      const { id: later } = await ingest(store, { labels: ['INBOX'] });
      // `due`'s `until` is in the real past on purpose (it's woken by the
      // explicit op below, not by a read) — `later` stays in the real
      // future so no implicit wake-on-read can touch it either.
      await store.apply({ kind: 'snooze', id: due, until: Date.now() - 60_000 }, 2_000);
      await store.apply({ kind: 'snooze', id: later, until: FAR_FUTURE }, 2_000);

      await store.apply({ kind: 'snooze.wake', now: Date.now() }, 3_000);

      expect(await latestIdsIn(store, 'inbox')).toEqual([due]);
      expect(await latestIdsIn(store, 'snoozed')).toEqual([later]);
    });

    it('snooze.wake reports the ids it woke and the next pending due time', async () => {
      const store = await freshStore();
      const { id: due } = await ingest(store, { labels: ['INBOX'] });
      const { id: later } = await ingest(store, { labels: ['INBOX'] });
      await store.apply({ kind: 'snooze', id: due, until: Date.now() - 60_000 }, 2_000);
      await store.apply({ kind: 'snooze', id: later, until: FAR_FUTURE }, 2_000);

      const result = await store.apply({ kind: 'snooze.wake', now: Date.now() }, 3_000);

      expect(result.applied).toEqual([due]);
      expect(result.updatedIds).toEqual([due]);
      expect(result.nextSnoozeDueAt).toBe(FAR_FUTURE);
    });
  });

  // -------------------------------------------------------------------------
  // Label rename / delete
  // -------------------------------------------------------------------------

  describe('label rename and delete', () => {
    it('renames the label on every live message that carries it, moving the counts', async () => {
      const store = await freshStore();
      const { id: tagged } = await ingest(store, { labels: ['INBOX', 'qalabel'] });
      const { id: other } = await ingest(store, { labels: ['INBOX', 'invoices'] });

      await store.apply({ kind: 'label.rename', from: 'qalabel', to: 'qarenamed' }, 2_000);

      expect(await latestIdsIn(store, 'qarenamed')).toEqual([tagged]);
      expect(await latestIdsIn(store, 'qalabel')).toEqual([]);
      expect((await store.labelCounts(['qarenamed'])).qarenamed).toEqual({ messages: 1, unread: 1, threads: 1 });
      expect(await latestIdsIn(store, 'invoices')).toEqual([other]);
    });

    it('deletes the label from every live message that carries it', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX', 'temp'] });

      await store.apply({ kind: 'label.delete', name: 'temp' }, 2_000);

      expect(await latestIdsIn(store, 'temp')).toEqual([]);
      expect(await latestIdsIn(store, 'inbox')).toEqual([id]);
      expect((await store.labelCounts(['temp'])).temp).toEqual({ messages: 0, unread: 0, threads: 0 });
    });

    it('deletes the label from a message regardless of its stored casing', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX', 'invoices'] });

      await store.apply({ kind: 'label.delete', name: 'Invoices' }, 2_000);

      expect(await latestIdsIn(store, 'invoices')).toEqual([]);
      expect(await latestIdsIn(store, 'inbox')).toEqual([id]);
    });
  });

  // -------------------------------------------------------------------------
  // Mark-folder-read (`folder.read` op)
  // -------------------------------------------------------------------------

  describe('folder.read (mark all as read)', () => {
    it('marks every unread message the folder lists as read, leaving other folders alone', async () => {
      const store = await freshStore();
      const { id: inboxMsg } = await ingest(store, { labels: ['INBOX'] });
      await ingest(store, { labels: ['TRASH'] });

      const result = await store.apply({ kind: 'folder.read', scope: { labelSlug: 'inbox' } }, 2_000);

      expect(result.updatedIds).toEqual([inboxMsg]);
      const inboxThread = (await store.listThreads({ labelSlug: 'inbox', pageSize: 10 })).threads[0];
      expect(inboxThread!.unreadCount).toBe(0);
      const trashThread = (await store.listThreads({ labelSlug: 'trash', pageSize: 10 })).threads[0];
      expect(trashThread!.unreadCount).toBe(1);
    });

    it('batches across several calls and marks everything eventually', async () => {
      const store = await freshStore();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { id } = await ingest(store, { labels: ['INBOX'], receivedAt: 1_000 + i, sentAt: 1_000 + i }, 1_000 + i);
        ids.push(id);
      }

      const result = await store.apply(
        { kind: 'folder.read', scope: { labelSlug: 'inbox' }, batchSize: 2, maxBatches: 10 },
        2_000,
      );

      expect(new Set(result.updatedIds)).toEqual(new Set(ids));
      const thread = (await store.listThreads({ labelSlug: 'inbox', pageSize: 10 })).threads;
      expect(thread.every((t) => t.unreadCount === 0)).toBe(true);
    });

    it('reports `more` when the batch cap is hit, and `false` once everything is marked', async () => {
      const store = await freshStore();
      for (let i = 0; i < 5; i++) {
        await ingest(store, { labels: ['INBOX'], receivedAt: 1_000 + i, sentAt: 1_000 + i }, 1_000 + i);
      }

      const capped = await store.apply(
        { kind: 'folder.read', scope: { labelSlug: 'inbox' }, batchSize: 2, maxBatches: 1 },
        2_000,
      );
      expect(capped.more).toBe(true);

      const finished = await store.apply(
        { kind: 'folder.read', scope: { labelSlug: 'inbox' }, batchSize: 2, maxBatches: 10 },
        2_000,
      );
      expect(finished.more).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Scheduled → sent transitions
  //
  // Explicit check requested for this task: does the thread move in the list
  // the same way in both backends once a scheduled send transitions to
  // sent? Verified below — both recompute a thread's position from its live
  // messages' own `sentDate`/`sent_at` on every write (Postgres live via
  // `MAX(COALESCE(receivedDate, sentDate, createdAt))`, the object via
  // `refreshThread`/`buildThreadSummary` after every `changeMessage`), and
  // the `scheduled` op patches that same field (`sentAt` → `sent_at`) on
  // both sides, so a scheduled-then-sent message's thread moves to the top
  // of Sent on both backends, identically.
  // -------------------------------------------------------------------------

  describe('scheduled to sent', () => {
    it('a scheduled send shows in Sent with __scheduled while still pending', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, {
        source: 'sent',
        labels: ['SENT', 'SCHEDULED'],
        sendStatus: 'scheduled',
        scheduledFor: 50_000,
        sentAt: 10_000,
        receivedAt: null,
      });

      expect(await latestIdsIn(store, 'sent')).toEqual([id]);
      const stats = await store.stats();
      expect(stats.scheduled).toBe(1);
    });

    it('the scheduled op transitions a message to sent, drops the SCHEDULED folder, and moves the thread to the top of Sent', async () => {
      const store = await freshStore();
      const { id: olderSent } = await ingest(
        store,
        { source: 'sent', labels: ['SENT'], sentAt: 20_000, receivedAt: null },
        20_000,
      );
      const { id: scheduled } = await ingest(store, {
        source: 'sent',
        labels: ['SENT', 'SCHEDULED'],
        sendStatus: 'scheduled',
        scheduledFor: 50_000,
        sentAt: 10_000,
        receivedAt: null,
      });
      // Before the transition, the older Sent thread is still newest.
      expect(await threadKeysIn(store, 'sent')).toEqual([olderSent, scheduled]);

      await store.apply(
        { kind: 'scheduled', id: scheduled, patch: { sendStatus: 'sent', sentAt: 60_000, dropScheduledLabel: true } },
        60_000,
      );

      expect(await threadKeysIn(store, 'sent')).toEqual([scheduled, olderSent]);
      const stats = await store.stats();
      expect(stats.scheduled).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Categories (AI classification) — folder membership must agree even
  // though the raw labels array is an intentional, documented difference.
  // -------------------------------------------------------------------------

  describe('categories (AI classification)', () => {
    it('marking important through categories makes the message show in Important on both backends', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX'] });

      await store.apply({ kind: 'categories', id, categories: ['newsletter'], important: true }, 2_000);

      // Folder membership (what a caller actually observes) must agree,
      // even though the object additionally gains the IMPORTANT label
      // (documented, intentional difference — see the file header).
      expect(await latestIdsIn(store, 'important')).toEqual([id]);
    });
  });

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  describe('attachments', () => {
    it('attachments ingested with the message show up in listAttachments and set hasAttachments', async () => {
      const store = await freshStore();
      const attId = nextId('att');
      const { id } = await ingest(store, {
        labels: ['INBOX'],
        attachments: [{ id: attId, messageId: 'ignored', fileName: 'report.pdf', size: 1234, contentType: 'application/pdf' }],
      });

      const message = await store.getMessage(id);
      expect(message!.hasAttachments).toBe(true);
      expect(message!.attachmentCount).toBe(1);
      const list = await store.listAttachments(id);
      expect(list.map((a) => a.id)).toEqual([attId]);
      expect(list[0]!.fileName).toBe('report.pdf');
    });

    it('attachment.create / attachment.delete keep the parent message count in step', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, { labels: ['INBOX'] });
      const attId = nextId('att');

      await store.apply(
        { kind: 'attachment.create', attachment: { id: attId, messageId: id, fileName: 'x.png', size: 10 } },
        2_000,
      );
      expect((await store.getMessage(id))!.hasAttachments).toBe(true);
      expect((await store.getMessage(id))!.attachmentCount).toBe(1);

      await store.apply({ kind: 'attachment.delete', id: attId }, 3_000);
      expect((await store.getMessage(id))!.hasAttachments).toBe(false);
      expect((await store.getMessage(id))!.attachmentCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  describe('drafts', () => {
    it('draft.create / draft.update / draft.delete round-trip through listDrafts and getDraft', async () => {
      const store = await freshStore();
      const draftId = nextId('draft');

      await store.apply({
        kind: 'draft.create',
        draft: { id: draftId, accountId: currentAccountId, subject: 'Draft subject', body: 'first body' },
      });
      let draft = await store.getDraft(draftId);
      expect(draft!.subject).toBe('Draft subject');
      let page = await store.listDrafts({ limit: 10 });
      expect(page.data.map((d) => d.id)).toContain(draftId);
      expect(page.totalCount).toBe(1);

      await store.apply({ kind: 'draft.update', id: draftId, patch: { subject: 'Edited subject' } }, 2_000);
      draft = await store.getDraft(draftId);
      expect(draft!.subject).toBe('Edited subject');

      await store.apply({ kind: 'draft.delete', id: draftId }, 3_000);
      expect(await store.getDraft(draftId)).toBeNull();
      page = await store.listDrafts({ limit: 10 });
      expect(page.data.map((d) => d.id)).not.toContain(draftId);
      expect(page.totalCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Message reads: getMessage / getThread / getMessages / listMessages
  // -------------------------------------------------------------------------

  describe('message and thread reads', () => {
    it('getMessage returns the same observable fields other than bodies', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, {
        labels: ['INBOX'],
        subject: 'Zebrafinch report',
        from: { email: 'dana@acme.example', name: 'Dana Whitlock' },
      });

      const message = await store.getMessage(id);
      expect(message!.id).toBe(id);
      expect(message!.subject).toBe('Zebrafinch report');
      expect((message!.from as { email?: string }).email).toBe('dana@acme.example');
      expect(message!.isRead).toBe(false);
      expect(message!.labels).toEqual(['INBOX']);
    });

    it('getMessage(id, {bodies:true}) returns body presence consistently; without it, bodies are absent', async () => {
      const store = await freshStore();
      const { id } = await ingest(store, {
        labels: ['INBOX'],
        content: { html: '<p>hi</p>', text: 'hi' },
      });

      const withBodies = await store.getMessage(id, { bodies: true });
      expect(withBodies!.textBody).toBeTruthy();
      expect(withBodies!.htmlBody).toBeTruthy();

      const withoutBodies = await store.getMessage(id);
      expect(withoutBodies!.textBody == null).toBe(true);
      expect(withoutBodies!.htmlBody == null).toBe(true);
    });

    it('getThread returns every live message of the thread, newest-aware, with bodies', async () => {
      const store = await freshStore();
      const threadId = 'thread_get';
      const { id: first } = await ingest(store, { threadId, labels: ['INBOX'], sentAt: 1_000 }, 1_000);
      const { id: second } = await ingest(
        store,
        { threadId, source: 'sent', labels: ['SENT'], sentAt: 2_000, receivedAt: null },
        2_000,
      );

      const thread = await store.getThread(threadId);
      expect(thread!.messages.map((m) => m.id).sort()).toEqual([first, second].sort());
    });

    it('getMessages returns only the live rows of the given ids, in this mailbox', async () => {
      const store = await freshStore();
      const { id: alive } = await ingest(store, { labels: ['INBOX'] });
      const { id: deleted } = await ingest(store, { labels: ['INBOX'] });
      await store.apply({ kind: 'delete', ids: [deleted] }, 2_000);

      const rows = await store.getMessages([alive, deleted, 'does_not_exist']);
      expect(rows.map((r) => r.id)).toEqual([alive]);
    });

    it('listMessages pages by sentAt/id, newest first, and the cursor continues correctly', async () => {
      const store = await freshStore();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { id } = await ingest(store, { labels: ['INBOX'], sentAt: 1_000 + i * 1_000 }, 1_000 + i * 1_000);
        ids.push(id);
      }

      const seen: string[] = [];
      let cursor: { sentAt: number; id: string } | null | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await store.listMessages({ limit: 1, cursor });
        if (page.data.length === 0) break;
        seen.push(page.data[0]!.id);
        cursor = page.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toEqual([...ids].reverse());
    });
  });
});

// ---------------------------------------------------------------------------
// Other differences found while writing this suite (not in the task's known
// list). Four of the five originally found here were fixed (task: mailbox
// store contract fixes #2-#5) and now live as ordinary, shared assertions in
// the `describe.each` block above — `snooze.wake` reporting, `label.delete`
// casing, `labelCounts`/`stats()` custom-label casing, and `folder.read`'s
// `more` flag. The one below is NOT fixed by that task (an object-side fix
// comes later) and stays a standalone, non-parameterised `it.fails`: the
// divergence only shows up on ONE of the two backends, so folding it into the
// `describe.each` block would make `it.fails` wrong for the other (it would
// unexpectedly pass there).
// ---------------------------------------------------------------------------

describe('other differences found (reported, not fixed here)', () => {
  // `store/postgres/mailbox-store.ts`'s reads go through `../../threads.ts`'s
  // `listThreadsForAccounts`/`threadListScope`, which wakes any snoozed mail
  // whose time has passed as a side effect of the read itself (the same rule
  // `scope.buildWake`/`wakeDueSnoozedMessages` give `markFolderRead` and the
  // existing `threadIdsIn` pglite tests — "opening the mailbox brings a due
  // mail back without waiting for the sweep", TASK-931). It compares against
  // the REAL wall clock, not the `at` passed to `apply`.
  //
  // `mailbox-object/reads.ts` has no such logic anywhere (verified by
  // reading every read function and grepping the whole `mailbox-object/`
  // directory for `Date.now()` / "wake" / "snooze_due": the only places that
  // wake snoozed mail are the explicit `snooze.wake` op and the alarm
  // described in design §3.6, item 2 — not a read). A message snoozed to a
  // time already in the past stays in the Snoozed folder on the object until
  // something explicit wakes it; on Postgres, the very next `listThreads`
  // call already moves it back to the inbox.
  it.fails('a plain read wakes an overdue snooze on Postgres; the object leaves it snoozed until something wakes it', async () => {
    const pg = await newPostgresStore();
    const obj = newObjectStore();
    const message: IngestMessage = {
      id: 'wake_repro',
      source: 'inbound',
      rfcMessageId: 'wake_repro@contract.test',
      threadId: null,
      from: { email: 'sender@example.com' },
      to: [{ email: 'me@contract.test' }],
      subject: 'x',
      preview: 'p',
      sentAt: 1_000,
      receivedAt: 1_000,
      createdAt: 1_000,
      isRead: false,
      labels: ['INBOX'],
      isSpam: false,
      isReply: false,
      attachments: [],
    };
    await pg.store.apply({ kind: 'ingest', message }, 1_000);
    await obj.store.apply({ kind: 'ingest', message }, 1_000);
    const pastDue = Date.now() - 60_000;
    await pg.store.apply({ kind: 'snooze', id: message.id, until: pastDue }, 2_000);
    await obj.store.apply({ kind: 'snooze', id: message.id, until: pastDue }, 2_000);

    const pgSnoozed = (await pg.store.listThreads({ labelSlug: 'snoozed', pageSize: 10 })).threads;
    const objSnoozed = (await obj.store.listThreads({ labelSlug: 'snoozed', pageSize: 10 })).threads;

    // Postgres: `pgSnoozed` is already empty here (auto-woken by the read
    // above). The object: `objSnoozed` still has the message. The two
    // backends disagree on a bare `listThreads` call with no op in between.
    expect(pgSnoozed.length).toBe(objSnoozed.length);
  });
});
