/**
 * `writes.ts`'s write core: `apply`/`applyBatch` for every task-B1 op
 * (ingest, flags, labels.set/add/remove, move, thread.label/read/set, delete
 * soft+hard), transactional atomicity (an op's outbox rows commit and roll
 * back together with everything else it touched), and a property-style test
 * asserting the incrementally maintained `threads`/`thread_labels`/
 * `label_counts`/`message_addresses` always equal a full `rebuildDerived()`.
 */
import { describe, expect, it } from 'vitest';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { migrateMailbox } from './migrate';
import { applyMailboxBatch, applyMailboxOp, type WritableStorage, rebuildDerived } from './writes';
import type { IngestMessage, MailboxOp, MailboxRef } from '../store/types';

function makeMailbox(ref: MailboxRef = { workspaceId: 'ws_1', accountId: 'acc_1' }) {
  const { storage } = createSqliteDurableObjectState();
  migrateMailbox(storage);
  return { storage: storage as unknown as WritableStorage, ref };
}

let seq = 0;
function makeIngest(overrides: Partial<IngestMessage> = {}): IngestMessage {
  seq += 1;
  return {
    id: `msg_${seq}`,
    source: 'inbound',
    rfcMessageId: `rfc-${seq}@example.com`,
    threadId: null,
    from: { email: 'alice@example.com', name: 'Alice' },
    to: [{ email: 'bob@example.com', name: 'Bob' }],
    subject: 'Hello',
    preview: 'Hi there',
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

function labelCountsByKey(storage: WritableStorage): Record<string, { messages: number; unread: number; threads: number }> {
  const rows = storage.sql
    .exec<{ label_key: string; messages: number; unread: number; threads: number }>('SELECT * FROM label_counts')
    .toArray();
  return Object.fromEntries(rows.map((r) => [r.label_key, { messages: r.messages, unread: r.unread, threads: r.threads }]));
}

function messageRow(storage: WritableStorage, id: string) {
  return storage.sql.exec('SELECT * FROM messages WHERE id = ?', id).toArray()[0] as Record<string, unknown> | undefined;
}

function messageLabelsOf(storage: WritableStorage, id: string): string[] {
  return storage.sql
    .exec<{ label_key: string }>('SELECT label_key FROM message_labels WHERE message_id = ? ORDER BY label_key', id)
    .toArray()
    .map((r) => r.label_key);
}

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

describe('ingest', () => {
  it('creates the message, its labels, addresses, folder counts and thread, and is idempotent by id', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });

    const first = applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    expect(first.ingest).toEqual({ id: message.id, threadKey: message.id, created: true });
    expect(first.applied).toEqual([message.id]);

    const row = messageRow(storage, message.id)!;
    expect(row.thread_key).toBe(message.id);
    expect(row.from_email).toBe('alice@example.com');
    expect(messageLabelsOf(storage, message.id)).toEqual(['inbox']);

    const counts = labelCountsByKey(storage);
    expect(counts.__total).toEqual({ messages: 1, unread: 1, threads: 0 }); // __total/__scheduled never bump `threads`
    expect(counts.__all).toEqual({ messages: 1, unread: 1, threads: 1 });
    expect(counts.inbox).toEqual({ messages: 1, unread: 1, threads: 1 });

    const addresses = storage.sql
      .exec<{ address: string; role: string }>('SELECT address, role FROM message_addresses WHERE message_id = ? ORDER BY role', message.id)
      .toArray();
    expect(addresses).toEqual([
      { address: 'alice@example.com', role: 'from' },
      { address: 'bob@example.com', role: 'to' },
    ]);

    const thread = storage.sql.exec('SELECT * FROM threads WHERE thread_key = ?', message.id).toArray()[0] as Record<string, unknown>;
    expect(thread.message_count).toBe(1);
    expect(thread.unread_count).toBe(1);

    // Replaying the same id is a no-op: same result, no double counting.
    const second = applyMailboxOp(storage, ref, { kind: 'ingest', message }, 2_000);
    expect(second.ingest).toEqual({ id: message.id, threadKey: message.id, created: false });
    expect(labelCountsByKey(storage).__total).toEqual({ messages: 1, unread: 1, threads: 0 });
  });

  it('refuses a duplicate RFC Message-ID under a different id for inbound mail (reports duplicateOf)', () => {
    const { storage, ref } = makeMailbox();
    const first = makeIngest({ rfcMessageId: 'rfc-shared@example.com' });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: first }, 1_000);

    const second = makeIngest({ rfcMessageId: 'rfc-shared@example.com' });
    const result = applyMailboxOp(storage, ref, { kind: 'ingest', message: second }, 2_000);
    expect(result.ingest).toEqual({ id: second.id, threadKey: first.id, created: false, duplicateOf: first.id });
    expect(messageRow(storage, second.id)).toBeUndefined();
  });

  it('dedups a sent copy by idempotency key, not by a (reused) rfc id', () => {
    const { storage, ref } = makeMailbox();
    const first = makeIngest({ source: 'sent', idempotencyKey: 'idem-1' });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: first }, 1_000);

    const retry = makeIngest({ source: 'sent', idempotencyKey: 'idem-1' });
    const result = applyMailboxOp(storage, ref, { kind: 'ingest', message: retry }, 2_000);
    expect(result.ingest).toEqual({ id: retry.id, threadKey: first.id, created: false, duplicateOf: first.id });
  });

  it('inserts both FTS rows and removes them on hard delete', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ subject: 'Your invoice is ready', searchText: 'please pay the invoice' });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    // "voice" only matches via the meta table's trigram tokenizer, not a whole-word match.
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_meta WHERE messages_fts_meta MATCH 'voice'").toArray().length).toBe(1);
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_body WHERE messages_fts_body MATCH 'invoice*'").toArray().length).toBe(1);

    applyMailboxOp(storage, ref, { kind: 'delete', ids: [message.id], hard: true }, 2_000);
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_meta WHERE messages_fts_meta MATCH 'voice'").toArray()).toEqual([]);
    expect(storage.sql.exec("SELECT rowid FROM messages_fts_body WHERE messages_fts_body MATCH 'invoice*'").toArray()).toEqual([]);
  });

  it('records a ledger.mail and an entity_event outbox row, and rolls both back if the op fails partway through', () => {
    const { storage, ref } = makeMailbox();
    const ok = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message: ok }, 1_000);

    const rows = storage.sql.exec<{ kind: string; payload: string }>('SELECT kind, payload FROM outbox ORDER BY seq').toArray();
    expect(rows.map((r) => r.kind)).toEqual(['ledger.mail', 'entity_event']);
    const ledgerPayload = JSON.parse(rows[0]!.payload);
    expect(ledgerPayload).toMatchObject({ messageId: ok.id, accountId: 'acc_1', from: 'alice@example.com' });
    expect(ledgerPayload.addresses.sort()).toEqual(['alice@example.com', 'bob@example.com']);
    const eventPayload = JSON.parse(rows[1]!.payload);
    expect(eventPayload).toMatchObject({ entityType: 'email', action: 'created', entityId: ok.id });

    // Force a failure partway through a SECOND ingest (after messages/labels/
    // addresses/FTS have already been written, but before the outbox rows):
    // nothing from this op should survive, including those outbox rows.
    const real = storage.sql;
    const throwing = {
      exec: (query: string, ...bindings: unknown[]) => {
        if (query.includes('INSERT INTO attachments')) throw new Error('simulated storage failure');
        return real.exec(query, ...bindings);
      },
      get databaseSize() {
        return real.databaseSize;
      },
    } as unknown as SqlStorage;
    const wrapped: WritableStorage = { sql: throwing, transactionSync: storage.transactionSync.bind(storage) };

    const failing = makeIngest({ attachments: [{ id: 'att_1', fileName: 'invoice.pdf', size: 10, messageId: 'whatever' }] });
    expect(() => applyMailboxOp(wrapped, ref, { kind: 'ingest', message: failing }, 3_000)).toThrow('simulated storage failure');

    expect(messageRow(storage, failing.id)).toBeUndefined();
    expect(storage.sql.exec('SELECT COUNT(*) AS n FROM outbox').toArray()[0]).toEqual({ n: rows.length }); // unchanged from before the failed attempt
    expect(storage.sql.exec('SELECT COUNT(*) AS n FROM message_addresses WHERE message_id = ?', failing.id).toArray()[0]).toEqual({ n: 0 });
  });

  it('inserts attachments and bumps has_attachments/attachment_count', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({
      attachments: [
        { id: 'att_1', fileName: 'a.pdf', size: 100, messageId: 'ignored', contentType: 'application/pdf' },
        { id: 'att_2', fileName: 'b.png', size: 200, messageId: 'ignored', isInline: true },
      ],
    });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    const row = messageRow(storage, message.id)!;
    expect(row.has_attachments).toBe(1);
    expect(row.attachment_count).toBe(2);
    const atts = storage.sql.exec('SELECT id, message_id, file_name FROM attachments ORDER BY id').toArray();
    expect(atts).toEqual([
      { id: 'att_1', message_id: message.id, file_name: 'a.pdf' },
      { id: 'att_2', message_id: message.id, file_name: 'b.png' },
    ]);
  });

  it('upserts a subscription for ham inbound mail with a subscription, but not for spam', () => {
    const { storage, ref } = makeMailbox();
    const sub = {
      senderEmail: 'news@list.example.com',
      senderName: 'List',
      senderDomain: 'list.example.com',
      listId: 'list-1',
      unsubscribeUrl: 'https://list.example.com/unsub',
      unsubscribeMailto: null,
      oneClick: true,
      messageCount: 1,
      lastSubject: 'Weekly digest',
      firstReceivedAt: new Date(1_000),
      lastReceivedAt: new Date(1_000),
    };
    applyMailboxOp(storage, ref, { kind: 'ingest', message: makeIngest({ subscription: sub }) }, 1_000);
    expect(storage.sql.exec('SELECT sender_email, message_count FROM subscriptions').toArray()).toEqual([
      { sender_email: sub.senderEmail, message_count: 1 },
    ]);

    // A second (different) message from the same sender bumps message_count.
    applyMailboxOp(storage, ref, { kind: 'ingest', message: makeIngest({ subscription: { ...sub, lastSubject: 'Another' } }) }, 2_000);
    expect(storage.sql.exec('SELECT message_count FROM subscriptions').toArray()).toEqual([{ message_count: 2 }]);

    applyMailboxOp(storage, ref, { kind: 'ingest', message: makeIngest({ isSpam: true, subscription: sub }) }, 3_000);
    expect(storage.sql.exec('SELECT COUNT(*) AS n FROM subscriptions').toArray()[0]).toEqual({ n: 1 }); // spam never upserts
  });
});

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

describe('flags', () => {
  it('single: isTrash:false restores the previous non-location state (leaveLocation), preserving ARCHIVE', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    // Simulate a drifted row carrying both ARCHIVE and TRASH (labels.set, not a move).
    applyMailboxOp(storage, ref, { kind: 'labels.set', id: message.id, labels: ['ARCHIVE', 'TRASH'] }, 1_100);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'flags', ids: [message.id], patch: { isTrash: false }, semantics: 'single' },
      1_200,
    );
    expect(result.applied).toEqual([message.id]);
    expect(result.message?.labels).toEqual(['ARCHIVE']);
    expect(result.message?.isTrash).toBe(false);
  });

  it('bulk: isTrash:false ("restore") always goes to INBOX, dropping ARCHIVE too', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'labels.set', id: message.id, labels: ['ARCHIVE', 'TRASH'] }, 1_100);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'flags', ids: [message.id], patch: { isTrash: false }, semantics: 'bulk' },
      1_200,
    );
    expect(result.message?.labels).toEqual(['INBOX']);
  });

  it('entering a location (isSpam:true) is identical for single and bulk semantics', () => {
    for (const semantics of ['single', 'bulk'] as const) {
      const { storage, ref } = makeMailbox();
      const message = makeIngest({ labels: ['INBOX'] });
      applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
      const result = applyMailboxOp(storage, ref, { kind: 'flags', ids: [message.id], patch: { isSpam: true }, semantics }, 1_100);
      expect(result.message?.labels).toEqual(['SPAM']);
      expect(result.message?.isSpam).toBe(true);
    }
  });

  it('bulk isTrash/isSpam moves clear a pending snooze; single does not', () => {
    const { storage, ref } = makeMailbox();
    const a = makeIngest();
    const b = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message: a }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: b }, 1_000);
    storage.sql.exec('UPDATE messages SET snoozed_until = 9999 WHERE id IN (?, ?)', a.id, b.id);

    applyMailboxOp(storage, ref, { kind: 'flags', ids: [a.id], patch: { isTrash: true }, semantics: 'single' }, 1_100);
    expect(messageRow(storage, a.id)!.snoozed_until).toBe(9999);

    applyMailboxOp(storage, ref, { kind: 'flags', ids: [b.id], patch: { isTrash: true }, semantics: 'bulk' }, 1_100);
    expect(messageRow(storage, b.id)!.snoozed_until).toBeNull();
  });

  it('isRead/isFlagged are plain columns with no label mirror', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ isRead: false });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'flags', ids: [message.id], patch: { isRead: true, isFlagged: true }, semantics: 'single' },
      1_100,
    );
    expect(result.message?.isRead).toBe(true);
    expect(result.message?.isFlagged).toBe(true);
    expect(result.message?.labels).toEqual(message.labels); // unchanged
    expect(labelCountsByKey(storage).__total.unread).toBe(0); // isRead:true drops unread count
  });

  it('reports a missing id without touching anything else', () => {
    const { storage, ref } = makeMailbox();
    const result = applyMailboxOp(storage, ref, { kind: 'flags', ids: ['does-not-exist'], patch: { isRead: true }, semantics: 'single' }, 1_000);
    expect(result).toEqual({ applied: [], missing: ['does-not-exist'], stale: [], ready: true });
  });

  it('a stale write (at below the touched clock) is skipped and reported', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'flags', ids: [message.id], patch: { isRead: true }, semantics: 'single' }, 2_000);

    const stale = applyMailboxOp(storage, ref, { kind: 'flags', ids: [message.id], patch: { isRead: false }, semantics: 'single' }, 1_500);
    expect(stale.stale).toEqual([message.id]);
    expect(messageRow(storage, message.id)!.is_read).toBe(1); // unchanged by the stale write
  });
});

// ---------------------------------------------------------------------------
// labels.set / labels.add / labels.remove
// ---------------------------------------------------------------------------

describe('labels.add / labels.remove / labels.set', () => {
  it('add normalises system slugs and mirrors starred/important', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'labels.add', ids: [message.id], labels: ['starred'], semantics: 'single' }, 1_100);
    expect(result.message?.labels).toEqual(['INBOX', 'STARRED']);
    expect(result.message?.isStarred).toBe(true);
    expect(messageLabelsOf(storage, message.id)).toEqual(['inbox', 'starred']);
  });

  it('remove never restores INBOX (unlike flags/move)', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['TRASH'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'labels.remove', ids: [message.id], labels: ['TRASH'], semantics: 'single' }, 1_100);
    expect(result.message?.labels).toEqual([]); // not ['INBOX'] — leaveLocation is `flags`-only
    expect(result.message?.isTrash).toBe(false);
  });

  it('add/remove are identical for single and bulk semantics', () => {
    for (const semantics of ['single', 'bulk'] as const) {
      const { storage, ref } = makeMailbox();
      const message = makeIngest({ labels: ['INBOX'] });
      applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
      const added = applyMailboxOp(storage, ref, { kind: 'labels.add', ids: [message.id], labels: ['TRASH'], semantics }, 1_100);
      expect(added.message?.labels).toEqual(['TRASH']); // location add still clears INBOX (addLabels' own rule)
    }
  });

  it('labels.set replaces the whole array', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX', 'Work'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    const result = applyMailboxOp(storage, ref, { kind: 'labels.set', id: message.id, labels: ['STARRED'] }, 1_100);
    expect(result.message?.labels).toEqual(['STARRED']);
    expect(messageLabelsOf(storage, message.id)).toEqual(['starred']);
  });

  it('bulk add/remove updates label_counts.threads on the 0⇄1 transition only', () => {
    const { storage, ref } = makeMailbox();
    const a = makeIngest({ labels: ['INBOX'] });
    const b = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: a }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: b }, 1_000);

    applyMailboxOp(storage, ref, { kind: 'labels.add', ids: [a.id], labels: ['Work'], semantics: 'bulk' }, 1_100);
    expect(labelCountsByKey(storage).work).toEqual({ messages: 1, unread: 1, threads: 1 });

    applyMailboxOp(storage, ref, { kind: 'labels.add', ids: [b.id], labels: ['Work'], semantics: 'bulk' }, 1_200);
    expect(labelCountsByKey(storage).work).toEqual({ messages: 2, unread: 2, threads: 2 }); // two different threads

    applyMailboxOp(storage, ref, { kind: 'labels.remove', ids: [a.id], labels: ['Work'], semantics: 'bulk' }, 1_300);
    expect(labelCountsByKey(storage).work).toEqual({ messages: 1, unread: 1, threads: 1 });
  });
});

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

describe('move', () => {
  it('moves to a location, clears a pending snooze, and mirrors isTrash/isSpam', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    storage.sql.exec('UPDATE messages SET snoozed_until = 5000 WHERE id = ?', message.id);

    const result = applyMailboxOp(storage, ref, { kind: 'move', ids: [message.id], location: 'TRASH' }, 1_100);
    expect(result.message?.labels).toEqual(['TRASH']);
    expect(result.message?.isTrash).toBe(true);
    expect(messageRow(storage, message.id)!.snoozed_until).toBeNull();
  });

  it('moving to INBOX never puts outgoing mail (SENT) back in the inbox', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['SENT', 'TRASH'], source: 'sent' });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    const result = applyMailboxOp(storage, ref, { kind: 'move', ids: [message.id], location: 'INBOX' }, 1_100);
    expect(result.message?.labels).toEqual(['SENT']);
  });
});

// ---------------------------------------------------------------------------
// thread.label / thread.read / thread.set
// ---------------------------------------------------------------------------

describe('thread.label / thread.read / thread.set', () => {
  it('thread.label touches every live message of the thread, not deleted ones', () => {
    const { storage, ref } = makeMailbox();
    const root = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: root }, 1_000);
    const reply = makeIngest({ labels: ['INBOX'], threadId: root.id });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: reply }, 1_100);
    const deletedReply = makeIngest({ labels: ['INBOX'], threadId: root.id });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: deletedReply }, 1_200);
    applyMailboxOp(storage, ref, { kind: 'delete', ids: [deletedReply.id] }, 1_300);

    const result = applyMailboxOp(storage, ref, { kind: 'thread.label', threadKey: root.id, label: 'Work', action: 'add' }, 1_400);
    expect(result.applied.sort()).toEqual([reply.id, root.id].sort());
    expect(messageLabelsOf(storage, root.id)).toContain('work');
    expect(messageLabelsOf(storage, reply.id)).toContain('work');
    expect(messageLabelsOf(storage, deletedReply.id)).not.toContain('work');
  });

  it('thread.read flips isRead for unread messages only, and returns updatedIds', () => {
    const { storage, ref } = makeMailbox();
    const root = makeIngest({ isRead: false });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: root }, 1_000);
    const reply = makeIngest({ isRead: true, threadId: root.id });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: reply }, 1_100);

    const result = applyMailboxOp(storage, ref, { kind: 'thread.read', threadKey: root.id, isRead: true }, 1_200);
    expect(result.applied).toEqual([root.id]); // reply was already read — gated on change
    expect(result.updatedIds).toEqual([root.id]);
    expect(messageRow(storage, root.id)!.is_read).toBe(1);
  });

  it('thread.set moves the message between threads, adjusting both threads\' aggregates', () => {
    const { storage, ref } = makeMailbox();
    const a = makeIngest({ labels: ['INBOX'] });
    const target = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: a }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: target }, 1_000);

    expect(labelCountsByKey(storage).inbox.threads).toBe(2);
    const result = applyMailboxOp(storage, ref, { kind: 'thread.set', id: a.id, threadId: target.id }, 1_100);
    expect(result.message?.threadId).toBe(target.id);
    expect(result.message?.threadKey).toBe(target.id);
    expect(labelCountsByKey(storage).inbox.threads).toBe(1); // merged into one thread
    expect(labelCountsByKey(storage).inbox.messages).toBe(2); // message-level membership unaffected

    const oldThread = storage.sql.exec('SELECT * FROM threads WHERE thread_key = ?', a.id).toArray();
    expect(oldThread).toEqual([]); // the old (now-empty) thread row is gone
    const newThread = storage.sql.exec('SELECT message_count FROM threads WHERE thread_key = ?', target.id).toArray()[0] as Record<string, unknown>;
    expect(newThread.message_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// delete (soft + hard)
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('soft delete removes the message from every folder/thread count but keeps the row and its labels', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'delete', ids: [message.id] }, 1_100);
    expect(result.applied).toEqual([message.id]);
    // An empty folder key is deleted outright, not left as a `0/0/0` row (`bumpLabelCounts`).
    expect(labelCountsByKey(storage).__total).toBeUndefined();
    expect(storage.sql.exec('SELECT * FROM threads').toArray()).toEqual([]);

    const row = messageRow(storage, message.id)!;
    expect(row.deleted_at).toBe(1_100);
    expect(row.labels_json).toBe(JSON.stringify(['INBOX'])); // untouched, for a possible restore
    expect(messageLabelsOf(storage, message.id)).toEqual(['inbox']); // message_labels also untouched
  });

  it('hard delete removes the row, its labels, addresses and attachments, and returns R2 storage paths', () => {
    const { storage, ref } = makeMailbox({ workspaceId: 'ws_1', accountId: 'acc_1' });
    const message = makeIngest({ attachments: [{ id: 'att_1', fileName: 'a.pdf', size: 1, messageId: 'x', storagePath: 'custom/key' }] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'delete', ids: [message.id], hard: true }, 1_100);
    expect(result.applied).toEqual([message.id]);
    expect(result.storagePaths).toContain('custom/key');
    expect(result.storagePaths!.some((p) => p.includes(`mail/ws_1/acc_1/${message.id}/`))).toBe(true);

    expect(messageRow(storage, message.id)).toBeUndefined();
    expect(storage.sql.exec('SELECT * FROM message_labels WHERE message_id = ?', message.id).toArray()).toEqual([]);
    expect(storage.sql.exec('SELECT * FROM message_addresses WHERE message_id = ?', message.id).toArray()).toEqual([]);
    expect(storage.sql.exec('SELECT * FROM attachments WHERE message_id = ?', message.id).toArray()).toEqual([]);
  });

  it('applyMailboxBatch runs each op in its own transaction and returns one OpResult per op', () => {
    const { storage, ref } = makeMailbox();
    const a = makeIngest();
    const b = makeIngest();
    const ops: MailboxOp[] = [
      { kind: 'ingest', message: a },
      { kind: 'ingest', message: b },
      { kind: 'flags', ids: [a.id], patch: { isRead: true }, semantics: 'single' },
    ];
    const results = applyMailboxBatch(storage, ref, ops, 1_000);
    expect(results).toHaveLength(3);
    expect(results[2]!.applied).toEqual([a.id]);
    expect(messageRow(storage, a.id)!.is_read).toBe(1);
    expect(messageRow(storage, b.id)!.is_read).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rebuildDerived vs incremental maintenance (property-style)
// ---------------------------------------------------------------------------

/** A tiny deterministic PRNG (mulberry32) so the property test is reproducible across runs/CI. */
function mulberry32(seedValue: number): () => number {
  let a = seedValue;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dumpDerivedState(storage: WritableStorage) {
  return {
    threads: storage.sql.exec('SELECT * FROM threads ORDER BY thread_key').toArray(),
    threadLabels: storage.sql.exec('SELECT * FROM thread_labels ORDER BY label_key, thread_key').toArray(),
    labelCounts: storage.sql.exec('SELECT * FROM label_counts ORDER BY label_key').toArray(),
    addresses: storage.sql.exec('SELECT * FROM message_addresses ORDER BY address, sent_at, message_id, role').toArray(),
  };
}

describe('rebuildDerived equals the incrementally maintained state', () => {
  it('after a few hundred random ops', () => {
    const { storage, ref } = makeMailbox();
    const rng = mulberry32(42);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const chance = (p: number) => rng() < p;

    const ids = Array.from({ length: 10 }, (_, i) => `pm_${i}`);
    const ingested = new Set<string>();
    const labelsPool = ['STARRED', 'IMPORTANT', 'Work', 'Invoices'];
    const locations = ['INBOX', 'ARCHIVE', 'TRASH', 'SPAM'] as const;
    let clock = 1_000;

    const OP_COUNT = 400;
    for (let i = 0; i < OP_COUNT; i++) {
      clock += 10;
      const id = pick(ids);

      if (!ingested.has(id) || chance(0.1)) {
        // (Re-)ingest: for an already-live id this is just a no-op replay.
        const threadId = chance(0.4) ? pick([...ingested, id]) : null;
        const message = makeIngest({
          id,
          threadId: ingested.has(id) ? null : threadId === id ? null : threadId,
          labels: [pick(locations), ...(chance(0.3) ? [pick(labelsPool)] : [])],
          isRead: chance(0.5),
          isSpam: chance(0.1),
        });
        applyMailboxOp(storage, ref, { kind: 'ingest', message }, clock);
        ingested.add(id);
        continue;
      }

      const roll = rng();
      if (roll < 0.2) {
        applyMailboxOp(
          storage,
          ref,
          { kind: 'flags', ids: [id], patch: { isRead: chance(0.5), isStarred: chance(0.5) }, semantics: chance(0.5) ? 'single' : 'bulk' },
          clock,
        );
      } else if (roll < 0.35) {
        applyMailboxOp(storage, ref, { kind: 'labels.add', ids: [id], labels: [pick(labelsPool)], semantics: chance(0.5) ? 'single' : 'bulk' }, clock);
      } else if (roll < 0.5) {
        applyMailboxOp(storage, ref, { kind: 'labels.remove', ids: [id], labels: [pick(labelsPool)], semantics: chance(0.5) ? 'single' : 'bulk' }, clock);
      } else if (roll < 0.65) {
        applyMailboxOp(storage, ref, { kind: 'move', ids: [id], location: pick(locations) }, clock);
      } else if (roll < 0.75) {
        const otherThread = pick([...ingested]);
        applyMailboxOp(storage, ref, { kind: 'thread.set', id, threadId: otherThread }, clock);
      } else if (roll < 0.85) {
        const row = messageRow(storage, id);
        if (row) applyMailboxOp(storage, ref, { kind: 'thread.label', threadKey: row.thread_key as string, label: pick(labelsPool), action: chance(0.5) ? 'add' : 'remove' }, clock);
      } else if (roll < 0.93) {
        const row = messageRow(storage, id);
        if (row) applyMailboxOp(storage, ref, { kind: 'thread.read', threadKey: row.thread_key as string, isRead: chance(0.5) }, clock);
      } else if (roll < 0.98) {
        applyMailboxOp(storage, ref, { kind: 'delete', ids: [id], hard: false }, clock);
      } else {
        applyMailboxOp(storage, ref, { kind: 'delete', ids: [id], hard: true }, clock);
        ingested.delete(id);
      }
    }

    const before = dumpDerivedState(storage);
    rebuildDerived(storage, ref, clock + 1);
    const after = dumpDerivedState(storage);
    expect(after).toEqual(before);
  });

  // Task B2: the same property, extended with the op kinds this task adds
  // (snooze/unsnooze/resnooze, snooze.wake, label.rename/delete, folder.read)
  // so rebuildDerived — still B1's own function, untouched by B2 — keeps
  // agreeing with the incrementally maintained state once those ops are in
  // the mix too.
  it('after a few hundred random ops, including snooze/wake, label rename/delete and folder.read', () => {
    const { storage, ref } = makeMailbox();
    const rng = mulberry32(99);
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const chance = (p: number) => rng() < p;

    const ids = Array.from({ length: 10 }, (_, i) => `pm_${i}`);
    const ingested = new Set<string>();
    const labelsPool = ['STARRED', 'IMPORTANT', 'Work', 'Invoices', 'Projects', 'Billing'];
    const locations = ['INBOX', 'ARCHIVE', 'TRASH', 'SPAM'] as const;
    const folderSlugs = ['inbox', '__all', 'work', 'invoices', 'starred', 'trash', 'spam'];
    const renamePairs = [
      ['Work', 'Projects'],
      ['Invoices', 'Billing'],
      ['Projects', 'Work'],
    ] as const;
    let clock = 1_000;

    const OP_COUNT = 400;
    for (let i = 0; i < OP_COUNT; i++) {
      clock += 10;

      // A mailbox-wide op (no single target id) instead of the usual per-id one.
      if (chance(0.06)) {
        const extraRoll = rng();
        if (extraRoll < 0.25) {
          applyMailboxOp(storage, ref, { kind: 'snooze.wake', now: clock }, clock);
        } else if (extraRoll < 0.5) {
          const [from, to] = pick(renamePairs);
          applyMailboxOp(storage, ref, { kind: 'label.rename', from, to }, clock);
        } else if (extraRoll < 0.75) {
          applyMailboxOp(storage, ref, { kind: 'label.delete', name: pick(labelsPool) }, clock);
        } else {
          applyMailboxOp(storage, ref, { kind: 'folder.read', scope: { labelSlug: pick(folderSlugs) }, batchSize: 3 }, clock);
        }
        continue;
      }

      const id = pick(ids);

      if (!ingested.has(id) || chance(0.1)) {
        const threadId = chance(0.4) ? pick([...ingested, id]) : null;
        const message = makeIngest({
          id,
          threadId: ingested.has(id) ? null : threadId === id ? null : threadId,
          labels: [pick(locations), ...(chance(0.3) ? [pick(labelsPool)] : [])],
          isRead: chance(0.5),
          isSpam: chance(0.1),
        });
        applyMailboxOp(storage, ref, { kind: 'ingest', message }, clock);
        ingested.add(id);
        continue;
      }

      const roll = rng();
      if (roll < 0.18) {
        applyMailboxOp(
          storage,
          ref,
          { kind: 'flags', ids: [id], patch: { isRead: chance(0.5), isStarred: chance(0.5) }, semantics: chance(0.5) ? 'single' : 'bulk' },
          clock,
        );
      } else if (roll < 0.3) {
        applyMailboxOp(storage, ref, { kind: 'labels.add', ids: [id], labels: [pick(labelsPool)], semantics: chance(0.5) ? 'single' : 'bulk' }, clock);
      } else if (roll < 0.42) {
        applyMailboxOp(storage, ref, { kind: 'labels.remove', ids: [id], labels: [pick(labelsPool)], semantics: chance(0.5) ? 'single' : 'bulk' }, clock);
      } else if (roll < 0.55) {
        applyMailboxOp(storage, ref, { kind: 'move', ids: [id], location: pick(locations) }, clock);
      } else if (roll < 0.63) {
        const otherThread = pick([...ingested]);
        applyMailboxOp(storage, ref, { kind: 'thread.set', id, threadId: otherThread }, clock);
      } else if (roll < 0.71) {
        const row = messageRow(storage, id);
        if (row) applyMailboxOp(storage, ref, { kind: 'thread.label', threadKey: row.thread_key as string, label: pick(labelsPool), action: chance(0.5) ? 'add' : 'remove' }, clock);
      } else if (roll < 0.78) {
        const row = messageRow(storage, id);
        if (row) applyMailboxOp(storage, ref, { kind: 'thread.read', threadKey: row.thread_key as string, isRead: chance(0.5) }, clock);
      } else if (roll < 0.86) {
        const row = messageRow(storage, id);
        if (row) {
          const labels = JSON.parse(row.labels_json as string) as string[];
          if (labels.includes('SNOOZED')) {
            applyMailboxOp(storage, ref, chance(0.5) ? { kind: 'resnooze', id, until: clock + 30 } : { kind: 'unsnooze', id }, clock);
          } else {
            applyMailboxOp(storage, ref, { kind: 'snooze', id, until: clock + 30 }, clock);
          }
        }
      } else if (roll < 0.96) {
        applyMailboxOp(storage, ref, { kind: 'delete', ids: [id], hard: false }, clock);
      } else {
        applyMailboxOp(storage, ref, { kind: 'delete', ids: [id], hard: true }, clock);
        ingested.delete(id);
      }
    }

    const before = dumpDerivedState(storage);
    rebuildDerived(storage, ref, clock + 1);
    const after = dumpDerivedState(storage);
    expect(after).toEqual(before);
  });
});
