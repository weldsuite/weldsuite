import { describe, it, expect } from 'vitest';
import {
  handleAssignConversation,
  handleTagConversation,
  handleChangeConversationStatus,
  handleChangePriority,
  handleSendReply,
  handleAddInternalNote,
} from './helpdesk';
import { makeActionContext } from '../../test/ctx';

// The conversation-mutation paths need a seeded helpdesk conversation; here we
// pin down the safety contract: with no resolvable conversation, each action
// no-ops with success:false rather than throwing.
describe('helpdesk actions without a conversation', () => {
  const ctx = makeActionContext();
  const handlers = {
    assign_conversation: handleAssignConversation,
    tag_conversation: handleTagConversation,
    change_conversation_status: handleChangeConversationStatus,
    change_priority: handleChangePriority,
    send_reply: handleSendReply,
    add_internal_note: handleAddInternalNote,
  };

  for (const [name, handler] of Object.entries(handlers)) {
    it(`${name} returns success:false when no conversation resolves`, async () => {
      expect(await handler({}, ctx)).toMatchObject({ success: false });
    });
  }

  it('resolves the conversation id from a helpdesk_conversation trigger', async () => {
    // With a conversation id present the guard passes; the downstream db call
    // then runs (and is exercised against pglite in integration). Here we only
    // assert the guard no longer short-circuits by checking a different error
    // path is reached (the mock db has no such conversation, so tag returns the
    // computed empty tag set).
    const triggerCtx = makeActionContext({
      triggerData: { entityType: 'helpdesk_conversation', entityId: 'conv_1' },
    });
    // tag_conversation reads then writes; against the empty mock db it should
    // not hit the "No conversation ID" guard.
    const res = (await handleTagConversation({ tags: ['vip'] }, triggerCtx).catch((e) => e)) as unknown;
    expect(res).not.toMatchObject({ error: 'No conversation ID' });
  });
});
