/**
 * Unit tests for inbox hub-event dispatch (Phase 2 mobile migration).
 * Run via: pnpm --filter platform exec vitest run ../../mobile/welddesk-app/hooks/inbox-realtime-dispatch.test.ts
 * (platform vitest config resolves TS; file is React-free).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  INBOX_HUB_TOPICS,
  dispatchInboxRealtimeEvent,
} from './inbox-realtime-dispatch';

describe('dispatchInboxRealtimeEvent', () => {
  it('subscribes to legacy helpdesk + desk/helpdesk entity topics', () => {
    expect(INBOX_HUB_TOPICS).toEqual([
      'helpdesk',
      'desk_conversation',
      'desk_message',
      'helpdesk_conversation',
      'helpdesk_conversation_message',
    ]);
  });

  it('maps legacy helpdesk.conversation_new via topic+event', () => {
    const onNewConversation = vi.fn();
    const onInboxInvalidate = vi.fn();
    dispatchInboxRealtimeEvent(
      'helpdesk',
      'conversation_new',
      { conversationId: 'c1', subject: 'Hi', customerName: 'Ada' },
      { onNewConversation, onInboxInvalidate },
    );
    expect(onNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1', subject: 'Hi', customerName: 'Ada' }),
    );
    expect(onInboxInvalidate).toHaveBeenCalledOnce();
  });

  it('maps desk_conversation created/updated/assigned', () => {
    const onNewConversation = vi.fn();
    const onConversationUpdated = vi.fn();
    dispatchInboxRealtimeEvent(
      'desk_conversation',
      'created',
      { id: 'd1', title: 'Email', name: 'Bob', state: 'open' },
      { onNewConversation, onConversationUpdated },
    );
    expect(onNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1', subject: 'Email', customerName: 'Bob', status: 'open' }),
    );

    dispatchInboxRealtimeEvent(
      'desk_conversation',
      'assigned',
      { id: 'd1', assigneeId: 'u1' },
      { onNewConversation, onConversationUpdated },
    );
    expect(onConversationUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd1', assignedToId: 'u1' }),
    );
  });

  it('maps desk_message created to onNewMessage', () => {
    const onNewMessage = vi.fn();
    dispatchInboxRealtimeEvent(
      'desk_message',
      'created',
      { conversationId: 'd1', body: 'hello', authorType: 'visitor' },
      { onNewMessage },
    );
    expect(onNewMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'd1',
        preview: 'hello',
        senderType: 'customer',
      }),
    );
  });

  it('ignores unknown legacy event names', () => {
    const onInboxInvalidate = vi.fn();
    dispatchInboxRealtimeEvent('helpdesk', 'typing', {}, { onInboxInvalidate });
    expect(onInboxInvalidate).not.toHaveBeenCalled();
  });
});
