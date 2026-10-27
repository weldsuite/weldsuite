import { describe, expect, it } from 'vitest';
import { realtimeMessageMetadata, realtimeMessageUpdate } from './use-weldchat-messages-realtime';

describe('realtimeMessageMetadata', () => {
  it("keeps an agent reply's approvals, so the live message shows its Approve / Reject card", () => {
    const approvals = [{ id: 'apr_1', label: 'Create task "Follow up"', status: 'pending' }];
    expect(realtimeMessageMetadata({ metadata: { approvals } })).toEqual({ approvals });
  });

  it('adds the inline-reply snapshot next to the rest', () => {
    const replyTo = { messageId: 'msg_1' };
    expect(realtimeMessageMetadata({ metadata: { approvals: [] }, replyTo })).toEqual({ approvals: [], replyTo });
  });

  it('is undefined when there is nothing to carry', () => {
    expect(realtimeMessageMetadata({})).toBeUndefined();
  });
});

describe('realtimeMessageUpdate', () => {
  it('changes only the metadata when an approval is decided, without marking the message edited', () => {
    const metadata = { approvals: [{ id: 'apr_1', label: 'Create task', status: 'approved' }] };
    expect(realtimeMessageUpdate('msg_1', { id: 'msg_1', metadata })).toEqual({ id: 'msg_1', metadata });
  });

  it('marks a content edit edited and leaves the author and reactions alone', () => {
    const update = realtimeMessageUpdate('msg_1', { id: 'msg_1', content: 'Fixed typo', isEdited: true, updatedAt: 'x' });
    expect(update).toEqual({ id: 'msg_1', content: 'Fixed typo', isEdited: true });
    expect(update).not.toHaveProperty('authorName');
    expect(update).not.toHaveProperty('reactions');
  });

  it('treats new content as an edit even without the flag', () => {
    expect(realtimeMessageUpdate('msg_1', { content: 'Hi' })).toMatchObject({ isEdited: true });
  });
});
