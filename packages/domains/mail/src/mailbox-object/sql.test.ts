/**
 * Unit tests for `./sql`'s conversions and row mapping: chunking, bit/epoch/
 * JSON helpers, and `mapMessageRow`'s round-trip into `MailMessageRecord`.
 */
import { describe, expect, it } from 'vitest';
import {
  chunk,
  epochToDate,
  epochToDateRequired,
  fromBit,
  mapMessageRow,
  type MessageRow,
  parseJsonArray,
  parseJsonOrNull,
  placeholders,
  toBit,
  toEpoch,
  toJson,
  toJsonOrNull,
} from './sql';

describe('chunk', () => {
  it('splits into chunks of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunk([], 2)).toEqual([]);
  });

  it('defaults to a size well under common SQLite bound-parameter limits', () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `id${i}`);
    const chunks = chunk(ids);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.flat()).toEqual(ids);
  });
});

describe('placeholders', () => {
  it('builds n comma-joined "?"', () => {
    expect(placeholders(0)).toBe('');
    expect(placeholders(1)).toBe('?');
    expect(placeholders(3)).toBe('?, ?, ?');
  });
});

describe('bit / bool conversions', () => {
  it('toBit / fromBit round-trip', () => {
    expect(toBit(true)).toBe(1);
    expect(toBit(false)).toBe(0);
    expect(toBit(null)).toBe(0);
    expect(toBit(undefined)).toBe(0);
    expect(fromBit(1)).toBe(true);
    expect(fromBit(0)).toBe(false);
    expect(fromBit(null)).toBe(false);
    expect(fromBit(undefined)).toBe(false);
  });
});

describe('epoch conversions', () => {
  it('toEpoch accepts a Date or a number, null/undefined pass through as null', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(toEpoch(d)).toBe(d.getTime());
    expect(toEpoch(12345)).toBe(12345);
    expect(toEpoch(null)).toBeNull();
    expect(toEpoch(undefined)).toBeNull();
  });

  it('epochToDate / epochToDateRequired', () => {
    expect(epochToDate(null)).toBeNull();
    expect(epochToDate(1000)?.getTime()).toBe(1000);
    expect(epochToDateRequired(2000).getTime()).toBe(2000);
  });
});

describe('JSON conversions', () => {
  it('toJson / toJsonOrNull / parseJsonArray / parseJsonOrNull round-trip', () => {
    expect(toJson(['a', 'b'])).toBe('["a","b"]');
    expect(toJsonOrNull(null)).toBeNull();
    expect(toJsonOrNull(undefined)).toBeNull();
    expect(toJsonOrNull(['x'])).toBe('["x"]');

    expect(parseJsonArray<string>(null)).toEqual([]);
    expect(parseJsonArray<string>(undefined)).toEqual([]);
    expect(parseJsonArray<string>('["a","b"]')).toEqual(['a', 'b']);

    expect(parseJsonOrNull<{ a: number }>(null)).toBeNull();
    expect(parseJsonOrNull<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
});

function baseRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg_1',
    rfc_message_id: 'rfc-1@example.com',
    external_message_id: null,
    provider_message_id: null,
    thread_id: null,
    thread_key: 'msg_1',
    conversation_id: null,
    from_email: 'alice@example.com',
    from_name: 'Alice',
    from_json: JSON.stringify({ email: 'alice@example.com', name: 'Alice' }),
    to_json: JSON.stringify([{ email: 'bob@example.com', name: 'Bob' }]),
    cc_json: null,
    bcc_json: null,
    reply_to_json: null,
    subject: 'Hello',
    subject_norm: 'hello',
    preview: 'Hi there',
    sent_at: 1_000,
    received_at: 1_001,
    sort_at: 1_001,
    is_read: 0,
    is_flagged: 0,
    is_draft: 0,
    is_reply: 0,
    is_forwarded: 0,
    labels_json: JSON.stringify(['INBOX']),
    categories_json: null,
    in_trash: 0,
    in_spam: 0,
    archived: 0,
    starred: 0,
    important: 0,
    has_attachments: 0,
    attachment_count: 0,
    in_reply_to: null,
    references_json: null,
    priority: 'normal',
    size_bytes: 1234,
    spf_status: null,
    dkim_status: null,
    dmarc_status: null,
    source: 'inbound',
    send_status: null,
    scheduled_for: null,
    trigger_run_id: null,
    idempotency_key: null,
    snoozed_until: null,
    snoozed_at: null,
    unsnoozed_at: null,
    unsnoozed_early: null,
    resnoozed_at: null,
    delivery_status: null,
    delivery_detail: null,
    delivery_updated_at: null,
    body_bits: 0,
    extra_json: null,
    created_at: 900,
    updated_at: 900,
    deleted_at: null,
    clk_read: 0,
    clk_labels: 0,
    clk_flag: 0,
    clk_delete: 0,
    clk_snooze: 0,
    clk_send: 0,
    clk_delivery: 0,
    clk_meta: 0,
    ...overrides,
  };
}

describe('mapMessageRow', () => {
  it('maps every stored field to the MailMessageRecord shape', () => {
    const record = mapMessageRow(baseRow(), { accountId: 'acc_1' });
    expect(record.id).toBe('msg_1');
    expect(record.accountId).toBe('acc_1');
    expect(record.messageId).toBe('rfc-1@example.com');
    expect(record.threadKey).toBe('msg_1');
    expect(record.from).toEqual({ email: 'alice@example.com', name: 'Alice' });
    expect(record.to).toEqual([{ email: 'bob@example.com', name: 'Bob' }]);
    expect(record.subject).toBe('Hello');
    expect(record.sentDate).toBeInstanceOf(Date);
    expect(record.sentDate.getTime()).toBe(1_000);
    expect(record.receivedDate?.getTime()).toBe(1_001);
    expect(record.isRead).toBe(false);
    expect(record.labels).toEqual(['INBOX']);
    expect(record.textBody).toBeNull();
    expect(record.htmlBody).toBeNull();
    expect(record.rawMessage).toBeNull();
    // Legacy custom-fields-blob columns the object's schema doesn't keep: always their default.
    expect(record.readReceipt).toBe(false);
    expect(record.deliveryReceipt).toBe(false);
    expect(record.isEncrypted).toBe(false);
    expect(record.isSigned).toBe(false);
    expect(record.sendProvider).toBeNull();
    expect(record.mailgunMessageId).toBeNull();
    expect(record.mailcowMessageId).toBeNull();
    expect(record.unsnoozeTriggerRunId).toBeNull();
  });

  it('round-trips extra_json into headers/customFields/clickedLinks/conversationId', () => {
    const extra = {
      headers: { 'X-Test': '1' },
      customFields: { foo: 'bar' },
      clickedLinks: [{ url: 'https://x.test', clickedAt: '2026-01-01T00:00:00.000Z', clickCount: 1 }],
      conversationId: 'conv_1',
    };
    const record = mapMessageRow(baseRow({ extra_json: JSON.stringify(extra) }), { accountId: 'acc_1' });
    expect(record.headers).toEqual(extra.headers);
    expect(record.customFields).toEqual(extra.customFields);
    expect(record.clickedLinks).toEqual(extra.clickedLinks);
    expect(record.conversationId).toBe('conv_1');
  });

  it('maps every mirrored boolean column', () => {
    const record = mapMessageRow(
      baseRow({ starred: 1, important: 1, in_trash: 1, in_spam: 1, is_flagged: 1, is_draft: 1, is_reply: 1, is_forwarded: 1 }),
      { accountId: 'acc_1' },
    );
    expect(record.isStarred).toBe(true);
    expect(record.isImportant).toBe(true);
    expect(record.isTrash).toBe(true);
    expect(record.isSpam).toBe(true);
    expect(record.isFlagged).toBe(true);
    expect(record.isDraft).toBe(true);
    expect(record.isReply).toBe(true);
    expect(record.isForwarded).toBe(true);
  });

  it('falls back to from_email/from_name when from_json is absent', () => {
    const record = mapMessageRow(baseRow({ from_json: '' }), { accountId: 'acc_1' });
    expect(record.from).toEqual({ email: 'alice@example.com', name: 'Alice' });
  });
});
