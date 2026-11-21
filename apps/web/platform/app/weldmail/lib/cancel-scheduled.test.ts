import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  createDraft: vi.fn(),
  deleteDraft: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('./api-client', () => ({
  mailApi: {
    messages: { get: api.get },
    drafts: { create: api.createDraft, delete: api.deleteDraft },
    scheduled: { cancel: api.cancel },
  },
}));

import {
  cancelScheduledToDraft,
  draftFromScheduled,
  droppedAttachmentCount,
  loadScheduledMessage,
  type ScheduledMessage,
} from './cancel-scheduled';

const scheduled: ScheduledMessage = {
  subject: 'Plan',
  to: [{ email: 'anna@x.com', name: 'Anna' }],
  cc: [{ email: 'bob@x.com' }],
  bcc: [],
  textBody: 'See the plan',
  htmlBody: '<p>See the plan</p>',
  inReplyTo: '<root@x.com>',
};

const withPdf: ScheduledMessage = {
  ...scheduled,
  attachments: [
    { id: 'att_1', fileName: 'plan.pdf', fileType: 'application/pdf', fileSize: 2048, url: '', uploadedAt: new Date(0) },
  ],
};

describe('draftFromScheduled', () => {
  it('keeps the recipients, subject, bodies and thread of the scheduled mail', () => {
    expect(draftFromScheduled(scheduled)).toEqual({
      to: ['anna@x.com'],
      cc: ['bob@x.com'],
      subject: 'Plan',
      body: 'See the plan',
      htmlBody: '<p>See the plan</p>',
      inReplyTo: '<root@x.com>',
    });
  });

  it('accepts plain address strings', () => {
    expect(draftFromScheduled({ subject: '', to: ['carl@x.com'] }).to).toEqual(['carl@x.com']);
  });

  it('leaves the attachments out, and counts them for the question that says so', () => {
    expect(draftFromScheduled(withPdf)).not.toHaveProperty('attachmentIds');
    expect(droppedAttachmentCount(withPdf)).toBe(1);
    expect(droppedAttachmentCount(scheduled)).toBe(0);
  });
});

describe('loadScheduledMessage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the mail as it is now, attachments included', async () => {
    api.get.mockResolvedValue({ success: true, data: withPdf });
    const loaded = await loadScheduledMessage('acc_1', 'msg_1');
    expect(api.get).toHaveBeenCalledWith('acc_1', 'msg_1');
    expect(loaded.success && droppedAttachmentCount(loaded.message)).toBe(1);
  });

  it('passes a failed read on', async () => {
    api.get.mockResolvedValue({ success: false, error: 'Message not found' });
    expect(await loadScheduledMessage('acc_1', 'msg_1')).toEqual({ success: false, error: 'Message not found' });
  });
});

describe('cancelScheduledToDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createDraft.mockResolvedValue({ success: true, data: { id: 'draft_1' } });
    api.deleteDraft.mockResolvedValue({ success: true });
    api.cancel.mockResolvedValue({ success: true, data: { id: 'msg_1' } });
  });

  it('writes the draft before it cancels the send', async () => {
    const result = await cancelScheduledToDraft('acc_1', 'msg_1', scheduled);
    expect(result).toEqual({ success: true, draftId: 'draft_1' });
    expect(api.createDraft).toHaveBeenCalledWith('acc_1', expect.objectContaining({ to: ['anna@x.com'], subject: 'Plan' }));
    expect(api.createDraft.mock.invocationCallOrder[0]).toBeLessThan(api.cancel.mock.invocationCallOrder[0]);
    expect(api.deleteDraft).not.toHaveBeenCalled();
  });

  it('removes the draft again when the cancel fails, so the mail is never in two places', async () => {
    api.cancel.mockResolvedValue({ success: false, error: 'Message is not in scheduled state' });
    const result = await cancelScheduledToDraft('acc_1', 'msg_1', scheduled);
    expect(result).toEqual({ success: false, error: 'Message is not in scheduled state' });
    expect(api.deleteDraft).toHaveBeenCalledWith('acc_1', 'draft_1');
  });

  it('cancels nothing when the draft cannot be written', async () => {
    api.createDraft.mockResolvedValue({ success: false, error: 'nope' });
    const result = await cancelScheduledToDraft('acc_1', 'msg_1', scheduled);
    expect(result.success).toBe(false);
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
