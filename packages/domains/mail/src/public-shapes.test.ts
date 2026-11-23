import { describe, expect, it } from 'vitest';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  parseBoolFlag,
  publicAttachment,
  publicListMessage,
  publicMessage,
} from './public-shapes';

type MessageArg = Parameters<typeof publicMessage>[0];
type ListArg = Parameters<typeof publicListMessage>[0];
type AttachmentArg = Parameters<typeof publicAttachment>[0];

describe('publicMessage', () => {
  it('drops the raw source, provider bookkeeping, the store key and the raw attachment rows', () => {
    const row = {
      id: 'msg_1',
      subject: 'Hello',
      textBody: 'Hi',
      rawMessage: 'RAW',
      headers: { 'x-a': '1' },
      triggerRunId: 'run_1',
      unsnoozeTriggerRunId: 'run_2',
      mailgunMessageId: 'mg',
      mailcowMessageId: 'mc',
      providerMessageId: 'p',
      sendProvider: 'cloudflare',
      idempotencyKey: 'idem',
      customFields: { a: 1 },
      deletedAt: null,
      threadKey: 't_1',
      attachments: [{ id: 'att_1', storagePath: 'workspaces/org/a.pdf' }],
    } as unknown as MessageArg;
    expect(publicMessage(row)).toEqual({ id: 'msg_1', subject: 'Hello', textBody: 'Hi' });
  });

  it('leaves the row it was given untouched', () => {
    const row = { id: 'msg_1', rawMessage: 'RAW' } as unknown as MessageArg;
    publicMessage(row);
    expect(row).toHaveProperty('rawMessage', 'RAW');
  });
});

describe('publicListMessage', () => {
  it('keeps the list columns only', () => {
    const row = {
      id: 'msg_1',
      accountId: 'mail_1',
      subject: 'Hello',
      isRead: false,
      labels: ['INBOX'],
      threadKey: 't_1',
      deliveryStatus: 'delivered',
    } as unknown as ListArg;
    const listed = publicListMessage(row);
    expect(listed).toMatchObject({ id: 'msg_1', accountId: 'mail_1', subject: 'Hello', isRead: false, labels: ['INBOX'] });
    expect(listed).not.toHaveProperty('threadKey');
    expect(listed).not.toHaveProperty('deliveryStatus');
    expect(Object.keys(listed)).toHaveLength(24);
  });
});

describe('publicAttachment', () => {
  it('is the metadata, never the storage path or a download URL', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const row = {
      id: 'att_1',
      messageId: 'msg_1',
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      size: 3,
      isInline: false,
      contentId: null,
      createdAt,
      storagePath: 'workspaces/org/a.pdf',
      downloadUrl: 'https://files.example/a.pdf',
    } as unknown as AttachmentArg;
    expect(publicAttachment(row)).toEqual({
      id: 'att_1',
      messageId: 'msg_1',
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      size: 3,
      isInline: false,
      contentId: null,
      createdAt,
    });
  });
});

describe('offset cursors', () => {
  it('round-trip, unpadded', () => {
    const cursor = encodeOffsetCursor(25);
    expect(cursor).toBe('bzoyNQ');
    expect(decodeOffsetCursor(cursor)).toBe(25);
  });

  it('read no cursor as the first page and anything else as invalid', () => {
    expect(decodeOffsetCursor(undefined)).toBe(0);
    expect(decodeOffsetCursor('')).toBe(0);
    expect(decodeOffsetCursor('not-a-cursor')).toBeNull();
    expect(decodeOffsetCursor(btoa('x:5'))).toBeNull();
  });
});

describe('parseBoolFlag', () => {
  it('reads "true" and "false", nothing else', () => {
    expect(parseBoolFlag('true')).toBe(true);
    expect(parseBoolFlag('false')).toBe(false);
    expect(parseBoolFlag('yes')).toBeUndefined();
    expect(parseBoolFlag(undefined)).toBeUndefined();
  });
});
