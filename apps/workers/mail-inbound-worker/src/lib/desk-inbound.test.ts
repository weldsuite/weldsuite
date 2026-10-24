/**
 * WeldDesk email channel, inbound side: which attachments reach the
 * conversation, and who is notified (same rule as the chat widget).
 */
import { describe, expect, it, vi } from 'vitest';

// The notification and DB layers are not under test here.
vi.mock('../db', () => ({ tenantSchema: {} }));
vi.mock('@weldsuite/db/lib/desk', () => ({
  findDeskConversationByRfcMessageIds: vi.fn(),
  findOpenEmailConversationByEmail: vi.fn(),
  findRecentEmailConversation: vi.fn(),
  normalizeEmailSubject: (s: string) => s,
}));

vi.mock('@weldsuite/notifications', () => ({
  createAndDeliverNotification: vi.fn(),
  helpdeskPreview: (text: string | null | undefined) => (text ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, 180),
}));

import {
  MAX_DESK_ATTACHMENTS,
  MAX_DESK_ATTACHMENT_BYTES,
  deskNotificationContent,
  planDeskNotification,
  selectDeskAttachments,
  storeDeskAttachments,
} from './desk-inbound';
import type { ParsedAttachment } from './email-storage';

const att = (fileName: string, size = 10, extra: Partial<ParsedAttachment> = {}): ParsedAttachment => ({
  fileName,
  contentType: 'application/pdf',
  content: new Uint8Array(size),
  ...extra,
});

describe('selectDeskAttachments', () => {
  it('keeps real files and drops empty parts', () => {
    expect(selectDeskAttachments([att('a.pdf'), att('empty.txt', 0)]).map((a) => a.fileName)).toEqual(['a.pdf']);
  });

  it('drops images the HTML body embeds by cid, keeps the same image when the body does not use it', () => {
    const logo = att('logo.png', 10, { contentId: '<logo@x>' });
    const photo = att('photo.png', 10, { contentId: 'photo@x' });
    const html = '<p>hi <img src="cid:logo@x"></p>';
    expect(selectDeskAttachments([logo, photo], html).map((a) => a.fileName)).toEqual(['photo.png']);
    expect(selectDeskAttachments([logo], null)).toHaveLength(1);
  });

  it('caps the file count and the total size', () => {
    const many = Array.from({ length: MAX_DESK_ATTACHMENTS + 5 }, (_, i) => att(`f${i}.pdf`));
    expect(selectDeskAttachments(many)).toHaveLength(MAX_DESK_ATTACHMENTS);

    const big = att('big.bin', MAX_DESK_ATTACHMENT_BYTES);
    const small = att('small.bin', 1);
    expect(selectDeskAttachments([big, small]).map((a) => a.fileName)).toEqual(['big.bin']);
  });
});

describe('storeDeskAttachments', () => {
  const bucket = () => {
    const put = vi.fn(async () => undefined);
    return { put, storage: { put } as unknown as R2Bucket };
  };

  it('uploads under desk/<workspace>/inbound/<email>/ and returns public URLs', async () => {
    const { put, storage } = bucket();
    const out = await storeDeskAttachments(
      { STORAGE: storage, R2_PUBLIC_URL: 'https://files.test/' },
      'ws_1',
      'email_1',
      [att('My Invoice (1).pdf', 42)],
    );

    expect(put).toHaveBeenCalledWith(
      'desk/ws_1/inbound/email_1/1_My_Invoice__1_.pdf',
      expect.any(Uint8Array),
      { httpMetadata: { contentType: 'application/pdf' } },
    );
    expect(out).toEqual([
      {
        name: 'My Invoice (1).pdf',
        url: 'https://files.test/desk/ws_1/inbound/email_1/1_My_Invoice__1_.pdf',
        contentType: 'application/pdf',
        filesize: 42,
      },
    ]);
  });

  it('stores nothing without a public URL to link to', async () => {
    const { put, storage } = bucket();
    expect(await storeDeskAttachments({ STORAGE: storage }, 'ws_1', 'e', [att('a.pdf')])).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });

  it('skips a file that fails to upload and keeps the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const put = vi.fn().mockRejectedValueOnce(new Error('r2 down')).mockResolvedValue(undefined);
    const out = await storeDeskAttachments(
      { STORAGE: { put } as unknown as R2Bucket, R2_PUBLIC_URL: 'https://files.test' },
      'ws_1',
      'e',
      [att('a.pdf'), att('b.pdf')],
    );
    expect(out.map((a) => a.name)).toEqual(['b.pdf']);
  });
});

describe('planDeskNotification', () => {
  const waiting = { state: 'open' as const, waitingSince: new Date() };
  const answered = { state: 'open' as const, waitingSince: null };

  it('notifies for every new conversation, assigned or not', () => {
    expect(planDeskNotification({ created: true, assigneeId: null, prior: null })).toBe('notify');
    expect(planDeskNotification({ created: true, assigneeId: 'user_1', prior: null })).toBe('notify');
  });

  it('leaves a reply on an assigned conversation to the assignee notification, never both', () => {
    expect(planDeskNotification({ created: false, assigneeId: 'user_1', prior: answered })).toBe('assignee_reply');
    expect(planDeskNotification({ created: false, assigneeId: 'user_1', prior: waiting })).toBe('assignee_reply');
  });

  it('notifies the team when an unassigned conversation was answered or closed, or unknown', () => {
    expect(planDeskNotification({ created: false, assigneeId: null, prior: answered })).toBe('notify');
    expect(
      planDeskNotification({ created: false, assigneeId: null, prior: { state: 'closed', waitingSince: null } }),
    ).toBe('notify');
    expect(planDeskNotification({ created: false, assigneeId: null, prior: null })).toBe('notify');
  });

  it('stays quiet while the team is already waiting on an unassigned conversation', () => {
    expect(planDeskNotification({ created: false, assigneeId: null, prior: waiting })).toBe('none');
  });
});

describe('deskNotificationContent', () => {
  it('titles a new conversation and a reply differently', () => {
    expect(deskNotificationContent({ isNew: true, customerName: 'Ann', body: 'Help', subject: 'S' }).title).toBe(
      'New conversation from Ann',
    );
    expect(deskNotificationContent({ isNew: false, customerName: 'Ann', body: 'Help', subject: 'S' }).title).toBe(
      'Ann replied',
    );
  });

  it('falls back from body to subject to the file names', () => {
    expect(deskNotificationContent({ isNew: true, customerName: 'A', body: '  ', subject: 'Printer' }).body).toBe(
      'Printer',
    );
    expect(
      deskNotificationContent({
        isNew: true,
        customerName: 'A',
        body: null,
        subject: '',
        attachmentNames: ['x.pdf', 'y.png'],
      }).body,
    ).toBe('Sent x.pdf, y.png');
    expect(deskNotificationContent({ isNew: true, customerName: ' ', body: null, subject: null }).title).toBe(
      'New conversation from A customer',
    );
  });
});
