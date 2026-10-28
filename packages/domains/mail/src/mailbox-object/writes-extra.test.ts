/**
 * `writes-extra.ts`'s write ops (task B2): snooze/resnooze/unsnooze/
 * `snooze.wake`, `scheduled`, `delivery.match`, `inbound.finalize`,
 * `categories`, `label.rename`/`label.delete`, `folder.read`, standalone
 * `attachment.*`, `subscription.*` and `draft.*`. Cases are ported from the
 * Postgres functions these mirror (`snooze.ts`, `labels.ts`'s
 * `relabelMessages`/`stripLabelFromMessages`, `delivery-events.ts`'s
 * `markSentCopy`, mail-api's `subscriptions.ts`/`scheduled.ts`).
 */
import { describe, expect, it } from 'vitest';
import { createSqliteDurableObjectState } from '@weldsuite/worker-kit/testing/durable-sqlite';
import { migrateMailbox } from './migrate';
import { applyMailboxOp, type WritableStorage } from './writes';
import type { IngestMessage, MailboxRef } from '../store/types';

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

function messageRow(storage: WritableStorage, id: string) {
  return storage.sql.exec('SELECT * FROM messages WHERE id = ?', id).toArray()[0] as Record<string, unknown> | undefined;
}

function messageLabelsOf(storage: WritableStorage, id: string): string[] {
  return storage.sql
    .exec<{ label_key: string }>('SELECT label_key FROM message_labels WHERE message_id = ? ORDER BY label_key', id)
    .toArray()
    .map((r) => r.label_key);
}

function labelCountsByKey(storage: WritableStorage): Record<string, { messages: number; unread: number; threads: number }> {
  const rows = storage.sql
    .exec<{ label_key: string; messages: number; unread: number; threads: number }>('SELECT * FROM label_counts')
    .toArray();
  return Object.fromEntries(rows.map((r) => [r.label_key, { messages: r.messages, unread: r.unread, threads: r.threads }]));
}

// ---------------------------------------------------------------------------
// snooze / unsnooze / resnooze / snooze.wake
// ---------------------------------------------------------------------------

describe('snooze / unsnooze / resnooze', () => {
  it('snooze removes INBOX, adds SNOOZED, and marks read (mirrors snooze.ts snoozeMessage)', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'], isRead: false });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'snooze', id: message.id, until: 5_000 }, 1_100);
    expect(result.message?.labels).toEqual(['SNOOZED']);
    expect(result.message?.isRead).toBe(true);
    const row = messageRow(storage, message.id)!;
    expect(row.snoozed_until).toBe(5_000);
    expect(row.snoozed_at).toBe(1_100);
  });

  it('unsnooze removes SNOOZED, restores INBOX, marks unread and unsnoozedEarly', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'snooze', id: message.id, until: 5_000 }, 1_100);

    const result = applyMailboxOp(storage, ref, { kind: 'unsnooze', id: message.id }, 1_200);
    expect(result.message?.labels).toEqual(['INBOX']);
    expect(result.message?.isRead).toBe(false);
    const row = messageRow(storage, message.id)!;
    expect(row.snoozed_until).toBeNull();
    expect(row.unsnoozed_early).toBe(1);
  });

  it('resnooze only changes snoozed_until and resnoozed_at, leaving labels/isRead alone', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'snooze', id: message.id, until: 5_000 }, 1_100);

    const result = applyMailboxOp(storage, ref, { kind: 'resnooze', id: message.id, until: 9_000 }, 1_200);
    expect(result.message?.labels).toEqual(['SNOOZED']); // unchanged
    const row = messageRow(storage, message.id)!;
    expect(row.snoozed_until).toBe(9_000);
    expect(row.resnoozed_at).toBe(1_200);
  });
});

describe('snooze.wake', () => {
  it('wakes every due snoozed message, restoring INBOX and unread, and reports the next due time', () => {
    const { storage, ref } = makeMailbox();
    const due = makeIngest({ labels: ['INBOX'] });
    const notDue = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: due }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: notDue }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'snooze', id: due.id, until: 5_000 }, 1_100);
    applyMailboxOp(storage, ref, { kind: 'snooze', id: notDue.id, until: 9_000 }, 1_100);

    const result = applyMailboxOp(storage, ref, { kind: 'snooze.wake', now: 6_000 }, 6_000);
    expect(result.applied).toEqual([due.id]);
    expect(result.updatedIds).toEqual([due.id]);
    expect(result.nextSnoozeDueAt).toBe(9_000);

    expect(messageRow(storage, due.id)!.snoozed_until).toBeNull();
    expect(messageLabelsOf(storage, due.id)).toEqual(['inbox']);
    expect(messageRow(storage, notDue.id)!.snoozed_until).toBe(9_000);
  });

  it('reports null when nothing remains snoozed', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'snooze', id: message.id, until: 5_000 }, 1_100);

    const result = applyMailboxOp(storage, ref, { kind: 'snooze.wake', now: 6_000 }, 6_000);
    expect(result.applied).toEqual([message.id]);
    expect(result.nextSnoozeDueAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scheduled
// ---------------------------------------------------------------------------

describe('scheduled', () => {
  it('transitions scheduled -> sent, dropping the SCHEDULED label and setting sentAt/externalMessageId (mirrors sendScheduledNow)', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({
      source: 'sent',
      labels: ['SENT', 'SCHEDULED'],
      sendStatus: 'scheduled',
      scheduledFor: 5_000,
      triggerRunId: 'wf_1',
    });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(
      storage,
      ref,
      {
        kind: 'scheduled',
        id: message.id,
        patch: { sendStatus: 'sent', scheduledFor: null, triggerRunId: null, sentAt: 5_500, externalMessageId: 'ext_1', dropScheduledLabel: true },
      },
      5_500,
    );
    expect(result.message?.labels).toEqual(['SENT']);
    expect(result.message?.sendStatus).toBe('sent');
    expect(result.message?.scheduledFor).toBeNull();
    expect(result.message?.providerMessageId).toBeNull(); // unaffected: external_message_id, not provider_message_id
    const row = messageRow(storage, message.id)!;
    expect(row.external_message_id).toBe('ext_1');
    expect(row.sent_at).toBe(5_500);
    expect(row.trigger_run_id).toBeNull();
  });

  it('cancel soft-deletes and clears the schedule (mirrors cancelScheduled)', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ source: 'sent', labels: ['SENT', 'SCHEDULED'], sendStatus: 'scheduled', scheduledFor: 5_000 });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'scheduled', id: message.id, patch: { sendStatus: 'cancelled', scheduledFor: null, triggerRunId: null, softDelete: true } },
      1_100,
    );
    expect(result.applied).toEqual([message.id]);
    const row = messageRow(storage, message.id)!;
    expect(row.send_status).toBe('cancelled');
    expect(row.deleted_at).toBe(1_100);
  });

  it('reschedule just updates scheduledFor/triggerRunId', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ source: 'sent', labels: ['SENT', 'SCHEDULED'], sendStatus: 'scheduled', scheduledFor: 5_000, triggerRunId: 'wf_1' });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    applyMailboxOp(storage, ref, { kind: 'scheduled', id: message.id, patch: { scheduledFor: 9_000, triggerRunId: 'wf_2' } }, 1_100);
    const row = messageRow(storage, message.id)!;
    expect(row.scheduled_for).toBe(9_000);
    expect(row.trigger_run_id).toBe('wf_2');
    expect(row.send_status).toBe('scheduled'); // untouched
  });
});

// ---------------------------------------------------------------------------
// delivery.match
// ---------------------------------------------------------------------------

describe('delivery.match', () => {
  it('matches the latest SENT copy to the recipient within the window and sets delivery status', () => {
    const { storage, ref } = makeMailbox();
    const sent = makeIngest({ source: 'sent', to: [{ email: 'carol@example.com' }], sentAt: 10_000 });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: sent }, 1_000);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'delivery.match', recipient: 'carol@example.com', eventAt: 10_500, status: 'delivered', detail: '250 OK' },
      10_600,
    );
    expect(result.applied).toEqual([sent.id]);
    const row = messageRow(storage, sent.id)!;
    expect(row.delivery_status).toBe('delivered');
    expect(row.delivery_detail).toBe('250 OK');
    expect(row.delivery_updated_at).toBe(10_500);
  });

  it('a lower-ranked status never overwrites a higher-ranked one (STATUS_RANK), and is reported stale', () => {
    const { storage, ref } = makeMailbox();
    const sent = makeIngest({ source: 'sent', to: [{ email: 'carol@example.com' }], sentAt: 10_000 });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: sent }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'delivery.match', recipient: 'carol@example.com', eventAt: 10_500, status: 'complained', detail: null }, 10_600);

    const downgrade = applyMailboxOp(
      storage,
      ref,
      { kind: 'delivery.match', recipient: 'carol@example.com', eventAt: 10_700, status: 'delivered', detail: null },
      10_800,
    );
    expect(messageRow(storage, sent.id)!.delivery_status).toBe('complained'); // unchanged
    // The rejected downgrade is reported `stale`, not `applied` — the caller
    // (delivery-events.ts's `markSentCopy`) reads this to answer whether the
    // event actually changed anything.
    expect(downgrade.applied).toEqual([]);
    expect(downgrade.stale).toEqual([sent.id]);
  });

  it('no match outside the window or for a different recipient is a quiet no-op', () => {
    const { storage, ref } = makeMailbox();
    const sent = makeIngest({ source: 'sent', to: [{ email: 'carol@example.com' }], sentAt: 10_000 });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: sent }, 1_000);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'delivery.match', recipient: 'dave@example.com', eventAt: 10_500, status: 'delivered', detail: null },
      10_600,
    );
    expect(result.applied).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// inbound.finalize
// ---------------------------------------------------------------------------

describe('inbound.finalize', () => {
  it('sets labels, read, flagged and isSpam as plain fields', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'], isRead: false });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'inbound.finalize', id: message.id, labels: ['INBOX', 'Work'], isRead: true, isFlagged: true, isSpam: false, deleted: false },
      1_100,
    );
    expect(result.message?.labels).toEqual(['INBOX', 'Work']);
    expect(result.message?.isRead).toBe(true);
    expect(result.message?.isFlagged).toBe(true);
    expect(result.message?.isSpam).toBe(false);
  });

  it('isSpam is written independently of whether SPAM is literally in labels', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'inbound.finalize', id: message.id, labels: ['SPAM'], isRead: false, isFlagged: false, isSpam: true, deleted: false },
      1_100,
    );
    expect(result.message?.isSpam).toBe(true);
    expect(result.message?.labels).toEqual(['SPAM']);
  });

  it('deleted:true soft-deletes the message', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    applyMailboxOp(
      storage,
      ref,
      { kind: 'inbound.finalize', id: message.id, labels: ['INBOX'], isRead: false, isFlagged: false, isSpam: false, deleted: true },
      1_100,
    );
    expect(messageRow(storage, message.id)!.deleted_at).toBe(1_100);
  });
});

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

describe('categories', () => {
  it('sets the categories array', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'categories', id: message.id, categories: ['ai:invoice'] }, 1_100);
    expect(result.message?.categories).toEqual(['ai:invoice']);
  });

  it('important:true also adds the IMPORTANT label (documented divergence from persistClassification\'s column-only write)', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'categories', id: message.id, categories: ['ai:urgent'], important: true }, 1_100);
    expect(result.message?.isImportant).toBe(true);
    expect(result.message?.labels).toEqual(['INBOX', 'IMPORTANT']);
    expect(labelCountsByKey(storage).important).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// label.rename / label.delete
// ---------------------------------------------------------------------------

describe('label.rename', () => {
  it('rewrites labels_json and message_labels case-insensitively, and renames the folder counts', () => {
    const { storage, ref } = makeMailbox();
    const a = makeIngest({ labels: ['INBOX', 'Work'] });
    const b = makeIngest({ labels: ['INBOX', 'work'] }); // different casing on the message
    applyMailboxOp(storage, ref, { kind: 'ingest', message: a }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: b }, 1_000);
    expect(labelCountsByKey(storage).work).toEqual({ messages: 2, unread: 2, threads: 2 });

    const result = applyMailboxOp(storage, ref, { kind: 'label.rename', from: 'Work', to: 'Projects' }, 1_100);
    expect(result.applied.sort()).toEqual([a.id, b.id].sort());

    expect(JSON.parse(messageRow(storage, a.id)!.labels_json as string)).toEqual(['INBOX', 'Projects']);
    expect(JSON.parse(messageRow(storage, b.id)!.labels_json as string)).toEqual(['INBOX', 'Projects']);
    expect(messageLabelsOf(storage, a.id)).toEqual(['inbox', 'projects']);

    const counts = labelCountsByKey(storage);
    expect(counts.work).toBeUndefined();
    expect(counts.projects).toEqual({ messages: 2, unread: 2, threads: 2 });
  });

  it('refreshes the thread row\'s denormalised labels', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX', 'Work'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'label.rename', from: 'Work', to: 'Projects' }, 1_100);

    const thread = storage.sql.exec('SELECT labels_json FROM threads WHERE thread_key = ?', message.id).toArray()[0] as { labels_json: string };
    expect(JSON.parse(thread.labels_json)).toContain('Projects');
  });

  it('a no-op rename (same key) changes nothing', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['INBOX', 'Work'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    const result = applyMailboxOp(storage, ref, { kind: 'label.rename', from: 'Work', to: 'work' }, 1_100);
    expect(result.applied).toEqual([]);
  });
});

describe('label.delete', () => {
  it('strips the label from every carrying message and removes its folder counts', () => {
    const { storage, ref } = makeMailbox();
    const a = makeIngest({ labels: ['INBOX', 'Invoices'] });
    const b = makeIngest({ labels: ['Invoices'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: a }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: b }, 1_000);

    const result = applyMailboxOp(storage, ref, { kind: 'label.delete', name: 'Invoices' }, 1_100);
    expect(result.applied.sort()).toEqual([a.id, b.id].sort());
    expect(JSON.parse(messageRow(storage, a.id)!.labels_json as string)).toEqual(['INBOX']);
    expect(JSON.parse(messageRow(storage, b.id)!.labels_json as string)).toEqual([]);
    expect(messageLabelsOf(storage, a.id)).toEqual(['inbox']);
    expect(labelCountsByKey(storage).invoices).toBeUndefined();
  });

  it('does not touch starred/important/trash/spam mirrors (custom labels never carry them)', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest({ labels: ['STARRED', 'Invoices'] });
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'label.delete', name: 'Invoices' }, 1_100);
    expect(messageRow(storage, message.id)!.starred).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// folder.read
// ---------------------------------------------------------------------------

describe('folder.read', () => {
  it('marks every unread message in the folder as read, across batches', () => {
    const { storage, ref } = makeMailbox();
    const ids = Array.from({ length: 5 }, () => {
      const m = makeIngest({ labels: ['INBOX'], isRead: false });
      applyMailboxOp(storage, ref, { kind: 'ingest', message: m }, 1_000);
      return m.id;
    });

    const result = applyMailboxOp(storage, ref, { kind: 'folder.read', scope: { labelSlug: 'inbox' }, batchSize: 2 }, 2_000);
    expect(result.updatedIds?.sort()).toEqual(ids.sort());
    expect(result.more).toBe(false);
    for (const id of ids) expect(messageRow(storage, id)!.is_read).toBe(1);
    expect(labelCountsByKey(storage).inbox.unread).toBe(0);
  });

  it('reports more:true when maxBatches is hit with work remaining', () => {
    const { storage, ref } = makeMailbox();
    for (let i = 0; i < 6; i++) {
      const m = makeIngest({ labels: ['INBOX'], isRead: false });
      applyMailboxOp(storage, ref, { kind: 'ingest', message: m }, 1_000);
    }
    const result = applyMailboxOp(storage, ref, { kind: 'folder.read', scope: { labelSlug: 'inbox' }, batchSize: 2, maxBatches: 2 }, 2_000);
    expect(result.updatedIds).toHaveLength(4);
    expect(result.more).toBe(true);
  });

  it('a custom label folder excludes archived mail; trash/spam folders include their own tos mail', () => {
    const { storage, ref } = makeMailbox();
    const archived = makeIngest({ labels: ['ARCHIVE', 'Work'], isRead: false });
    const inTrash = makeIngest({ labels: ['TRASH'], isRead: false });
    applyMailboxOp(storage, ref, { kind: 'ingest', message: archived }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: inTrash }, 1_000);

    const work = applyMailboxOp(storage, ref, { kind: 'folder.read', scope: { labelSlug: 'Work' } }, 2_000);
    expect(work.updatedIds).toEqual([]); // archived mail is hidden from a custom label's folder
    expect(messageRow(storage, archived.id)!.is_read).toBe(0);

    const trash = applyMailboxOp(storage, ref, { kind: 'folder.read', scope: { labelSlug: 'trash' } }, 2_100);
    expect(trash.updatedIds).toEqual([inTrash.id]);
  });
});

// ---------------------------------------------------------------------------
// attachment.create / update / delete / associate
// ---------------------------------------------------------------------------

describe('attachment.*', () => {
  it('create inserts the row and bumps the parent message counts', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'attachment.create', attachment: { id: 'att_1', messageId: message.id, fileName: 'a.pdf', size: 10 } },
      1_100,
    );
    expect(result.applied).toEqual(['att_1']);
    const row = messageRow(storage, message.id)!;
    expect(row.has_attachments).toBe(1);
    expect(row.attachment_count).toBe(1);
  });

  it('create is idempotent by id', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    const att = { id: 'att_1', messageId: message.id, fileName: 'a.pdf', size: 10 };
    applyMailboxOp(storage, ref, { kind: 'attachment.create', attachment: att }, 1_100);
    applyMailboxOp(storage, ref, { kind: 'attachment.create', attachment: att }, 1_200);
    expect(messageRow(storage, message.id)!.attachment_count).toBe(1);
  });

  it('update patches fields without touching message counts unless messageId changes', () => {
    const { storage, ref } = makeMailbox();
    const a = makeIngest();
    const b = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message: a }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: b }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'attachment.create', attachment: { id: 'att_1', messageId: a.id, fileName: 'a.pdf', size: 10 } }, 1_100);

    applyMailboxOp(storage, ref, { kind: 'attachment.update', id: 'att_1', patch: { fileName: 'renamed.pdf' } }, 1_200);
    const att = storage.sql.exec('SELECT file_name, message_id FROM attachments WHERE id = ?', 'att_1').toArray()[0] as Record<string, unknown>;
    expect(att.file_name).toBe('renamed.pdf');
    expect(messageRow(storage, a.id)!.attachment_count).toBe(1);

    applyMailboxOp(storage, ref, { kind: 'attachment.update', id: 'att_1', patch: { messageId: b.id } }, 1_300);
    expect(messageRow(storage, a.id)!.attachment_count).toBe(0);
    expect(messageRow(storage, b.id)!.attachment_count).toBe(1);
  });

  it('delete soft-deletes, returns the storage path, and refreshes the parent count', () => {
    const { storage, ref } = makeMailbox();
    const message = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message }, 1_000);
    applyMailboxOp(
      storage,
      ref,
      { kind: 'attachment.create', attachment: { id: 'att_1', messageId: message.id, fileName: 'a.pdf', size: 10, storagePath: 'ws/key' } },
      1_100,
    );

    const result = applyMailboxOp(storage, ref, { kind: 'attachment.delete', id: 'att_1' }, 1_200);
    expect(result.storagePaths).toEqual(['ws/key']);
    expect(messageRow(storage, message.id)!.attachment_count).toBe(0);
  });

  it('associate reparents attachments onto a message and refreshes its counts', () => {
    const { storage, ref } = makeMailbox();
    const placeholder = makeIngest();
    const target = makeIngest();
    applyMailboxOp(storage, ref, { kind: 'ingest', message: placeholder }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'ingest', message: target }, 1_000);
    applyMailboxOp(
      storage,
      ref,
      { kind: 'attachment.create', attachment: { id: 'att_1', messageId: placeholder.id, fileName: 'a.pdf', size: 10 } },
      1_100,
    );

    const result = applyMailboxOp(storage, ref, { kind: 'attachment.associate', messageId: target.id, attachmentIds: ['att_1'] }, 1_200);
    expect(result.applied).toEqual([target.id]);
    expect(messageRow(storage, target.id)!.attachment_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// subscription.upsert / subscription.status
// ---------------------------------------------------------------------------

describe('subscription.upsert', () => {
  it('inserts a new subscription from an aggregate', () => {
    const { storage, ref } = makeMailbox();
    const result = applyMailboxOp(
      storage,
      ref,
      {
        kind: 'subscription.upsert',
        values: [
          {
            senderEmail: 'news@list.example.com',
            senderName: 'List',
            senderDomain: 'list.example.com',
            listId: 'list-1',
            unsubscribeUrl: 'https://list.example.com/unsub',
            unsubscribeMailto: null,
            oneClick: true,
            messageCount: 3,
            lastSubject: 'Digest',
            firstReceivedAt: new Date(1_000),
            lastReceivedAt: new Date(3_000),
          },
        ],
      },
      5_000,
    );
    expect(result.applied).toHaveLength(1);
    const row = storage.sql.exec('SELECT message_count, first_received_at FROM subscriptions WHERE sender_email = ?', 'news@list.example.com').toArray()[0] as Record<string, unknown>;
    expect(row.message_count).toBe(3);
    expect(row.first_received_at).toBe(1_000);
  });

  it('on conflict takes GREATEST(messageCount)/LEAST(firstReceivedAt), unlike the per-ingest bump', () => {
    const { storage, ref } = makeMailbox();
    const base = {
      senderEmail: 'news@list.example.com',
      senderName: 'List',
      senderDomain: 'list.example.com',
      listId: null,
      unsubscribeUrl: null,
      unsubscribeMailto: null,
      oneClick: false,
      lastSubject: 'First',
    };
    applyMailboxOp(storage, ref, { kind: 'subscription.upsert', values: [{ ...base, messageCount: 5, firstReceivedAt: new Date(2_000), lastReceivedAt: new Date(2_000) }] }, 1_000);
    // A smaller recount (e.g. a narrower backfill window) never lowers the stored count, and an earlier first-seen date wins.
    applyMailboxOp(storage, ref, { kind: 'subscription.upsert', values: [{ ...base, messageCount: 2, firstReceivedAt: new Date(500), lastReceivedAt: new Date(2_500) }] }, 2_000);
    const row = storage.sql.exec('SELECT message_count, first_received_at FROM subscriptions WHERE sender_email = ?', base.senderEmail).toArray()[0] as Record<string, unknown>;
    expect(row.message_count).toBe(5);
    expect(row.first_received_at).toBe(500);
  });
});

describe('subscription.status', () => {
  it('marks a subscription unsubscribed (mirrors unsubscribe())', () => {
    const { storage, ref } = makeMailbox();
    applyMailboxOp(
      storage,
      ref,
      {
        kind: 'subscription.upsert',
        values: [
          {
            senderEmail: 'news@list.example.com',
            senderName: null,
            senderDomain: 'list.example.com',
            listId: null,
            unsubscribeUrl: null,
            unsubscribeMailto: null,
            oneClick: false,
            messageCount: 1,
            lastSubject: null,
            firstReceivedAt: new Date(1_000),
            lastReceivedAt: new Date(1_000),
          },
        ],
      },
      1_000,
    );
    const subId = (storage.sql.exec('SELECT id FROM subscriptions').toArray()[0] as { id: string }).id;

    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'subscription.status', id: subId, patch: { status: 'unsubscribed', method: 'link', at: 2_000, by: 'user_1' } },
      2_000,
    );
    expect(result.applied).toEqual([subId]);
    const row = storage.sql.exec('SELECT status, unsubscribe_method, unsubscribed_by FROM subscriptions WHERE id = ?', subId).toArray()[0] as Record<string, unknown>;
    expect(row.status).toBe('unsubscribed');
    expect(row.unsubscribe_method).toBe('link');
    expect(row.unsubscribed_by).toBe('user_1');
  });
});

// ---------------------------------------------------------------------------
// draft.create / draft.update / draft.delete
// ---------------------------------------------------------------------------

describe('draft.*', () => {
  it('create inserts a draft row with derived attachment flags', () => {
    const { storage, ref } = makeMailbox();
    const result = applyMailboxOp(
      storage,
      ref,
      { kind: 'draft.create', draft: { id: 'draft_1', accountId: 'acc_1', subject: 'Hi', to: ['bob@example.com'], attachmentIds: ['att_1', 'att_2'] } },
      1_000,
    );
    expect(result.applied).toEqual(['draft_1']);
    const row = storage.sql.exec('SELECT subject, to_json, has_attachments, attachment_count FROM drafts WHERE id = ?', 'draft_1').toArray()[0] as Record<string, unknown>;
    expect(row.subject).toBe('Hi');
    expect(JSON.parse(row.to_json as string)).toEqual(['bob@example.com']);
    expect(row.has_attachments).toBe(1);
    expect(row.attachment_count).toBe(2);
  });

  it('create is idempotent by id', () => {
    const { storage, ref } = makeMailbox();
    const draft = { id: 'draft_1', accountId: 'acc_1', subject: 'Hi' };
    applyMailboxOp(storage, ref, { kind: 'draft.create', draft }, 1_000);
    applyMailboxOp(storage, ref, { kind: 'draft.create', draft: { ...draft, subject: 'Changed' } }, 1_100);
    const row = storage.sql.exec('SELECT subject FROM drafts WHERE id = ?', 'draft_1').toArray()[0] as Record<string, unknown>;
    expect(row.subject).toBe('Hi'); // the second create was a no-op replay
  });

  it('update patches fields and recomputes attachment flags, and bumps last_auto_saved_at', () => {
    const { storage, ref } = makeMailbox();
    applyMailboxOp(storage, ref, { kind: 'draft.create', draft: { id: 'draft_1', accountId: 'acc_1', subject: 'Hi' } }, 1_000);

    applyMailboxOp(storage, ref, { kind: 'draft.update', id: 'draft_1', patch: { subject: 'Updated', attachmentIds: ['att_1'] } }, 1_100);
    const row = storage.sql.exec('SELECT subject, has_attachments, attachment_count, last_auto_saved_at FROM drafts WHERE id = ?', 'draft_1').toArray()[0] as Record<string, unknown>;
    expect(row.subject).toBe('Updated');
    expect(row.has_attachments).toBe(1);
    expect(row.attachment_count).toBe(1);
    expect(row.last_auto_saved_at).toBe(1_100);
  });

  it('update on a missing/deleted draft reports missing', () => {
    const { storage, ref } = makeMailbox();
    const result = applyMailboxOp(storage, ref, { kind: 'draft.update', id: 'does-not-exist', patch: { subject: 'x' } }, 1_000);
    expect(result).toMatchObject({ missing: ['does-not-exist'] });
  });

  it('delete soft-deletes and is not re-deletable', () => {
    const { storage, ref } = makeMailbox();
    applyMailboxOp(storage, ref, { kind: 'draft.create', draft: { id: 'draft_1', accountId: 'acc_1' } }, 1_000);
    const first = applyMailboxOp(storage, ref, { kind: 'draft.delete', id: 'draft_1' }, 1_100);
    expect(first.applied).toEqual(['draft_1']);
    const second = applyMailboxOp(storage, ref, { kind: 'draft.delete', id: 'draft_1' }, 1_200);
    expect(second.missing).toEqual(['draft_1']);
  });
});
