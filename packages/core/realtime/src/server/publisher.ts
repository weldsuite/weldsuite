import type { Attachment } from '../types';

/** Service binding interface — compatible with Cloudflare's Fetcher */
interface ServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Server-side publisher for the real-time event system.
 *
 * Used by Cloudflare Workers to publish events to the realtime-worker
 * via service binding. Supports workspace events (WorkspaceHub),
 * conversation events (ConversationRoom), and chat events (ChatRoom).
 *
 * Usage:
 *   const realtime = new RealtimePublisher(c.env.REALTIME);
 *   await realtime.entityCreated(orgId, 'contact', contact, userId);
 */
export class RealtimePublisher {
  constructor(private binding: ServiceBinding) {}

  // ============================================
  // Workspace Events → WorkspaceHub DO
  // ============================================

  async publish(
    workspaceId: string,
    topic: string,
    event: string,
    data: unknown,
    userId: string,
  ): Promise<void> {
    const res = await this.binding.fetch('https://internal/publish/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, topic, event, data, userId }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `[realtime publish] ${res.status} ${res.statusText} for topic "${topic}" event "${event}": ${body}`,
      );
    }
  }

  /**
   * Publish a personal-topic event with the recipient access list pre-attached.
   * WorkspaceHub's `handlePublish` strips `_access` from the payload and only
   * fans the event out to WebSockets tagged with a matching userId. This is
   * the defence-in-depth half of personal-topic isolation; the subscribe-side
   * half lives in `isPersonalTopicForOtherUser` inside the DO.
   */
  private async publishPersonal(
    workspaceId: string,
    topic: string,
    event: string,
    data: Record<string, unknown> | unknown,
    targetUserId: string,
  ): Promise<void> {
    const payload = {
      ...(data as Record<string, unknown>),
      _access: { userIds: [targetUserId] },
    };
    return this.publish(workspaceId, topic, event, payload, 'system');
  }

  async entityCreated(workspaceId: string, topic: string, data: unknown, userId: string) {
    return this.publish(workspaceId, topic, 'created', data, userId);
  }

  async entityUpdated(workspaceId: string, topic: string, data: unknown, userId: string) {
    return this.publish(workspaceId, topic, 'updated', data, userId);
  }

  async entityDeleted(workspaceId: string, topic: string, id: string, userId: string) {
    return this.publish(workspaceId, topic, 'deleted', { id }, userId);
  }

  async entityArchived(workspaceId: string, topic: string, id: string, userId: string) {
    return this.publish(workspaceId, topic, 'archived', { id }, userId);
  }

  async notify(workspaceId: string, userId: string, notification: unknown) {
    return this.publishPersonal(workspaceId, `notification.${userId}`, 'created', notification, userId);
  }

  async mailEvent(workspaceId: string, userId: string, event: string, data: unknown) {
    return this.publishPersonal(workspaceId, `mail.${userId}`, event, data, userId);
  }

  async inboxEvent(workspaceId: string, agentId: string, event: string, data: unknown) {
    return this.publishPersonal(workspaceId, `inbox.${agentId}`, event, data, agentId);
  }

  async helpdeskEvent(workspaceId: string, event: string, data: unknown) {
    return this.publish(workspaceId, 'helpdesk', event, data, 'system');
  }

  async supportEvent(workspaceId: string, event: string, data: unknown) {
    // Publish to both WorkspaceHub (for useTopic subscribers) and SupportRoom DO (for WebSocket room subscribers)
    await this.publish(workspaceId, 'support', event, data, 'system');
    await this.supportPublish(workspaceId, { type: event, data, ts: Date.now() });
  }

  // ============================================
  // Support Events → SupportRoom DO
  // ============================================

  async supportPublish(workspaceId: string, payload: unknown): Promise<void> {
    await this.binding.fetch(`https://internal/publish/support/${workspaceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  // ============================================
  // Conversation Events → ConversationRoom DO
  // ============================================

  async conversationPublish(conversationId: string, payload: unknown): Promise<void> {
    await this.binding.fetch(
      `https://internal/publish/conversation/${conversationId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
  }

  async conversationMessage(
    conversationId: string,
    message: {
      id: string;
      content: string;
      senderId: string;
      senderName: string;
      senderType: string;
      attachments?: Attachment[];
    },
  ) {
    return this.conversationPublish(conversationId, {
      type: 'message',
      ...message,
      ts: Date.now(),
    });
  }

  async conversationSystem(conversationId: string, event: string, data: unknown) {
    return this.conversationPublish(conversationId, {
      type: 'system',
      event,
      data,
      ts: Date.now(),
    });
  }

  async conversationAiToken(conversationId: string, messageId: string, token: string) {
    return this.conversationPublish(conversationId, {
      type: 'ai:token',
      messageId,
      token,
    });
  }

  async conversationAiComplete(conversationId: string, messageId: string, content: string) {
    return this.conversationPublish(conversationId, {
      type: 'ai:complete',
      messageId,
      content,
    });
  }

  // ============================================
  // Chat Events → ChatRoom DO
  // ============================================

  async chatPublish(channelId: string, payload: unknown): Promise<void> {
    await this.binding.fetch(`https://internal/publish/chat/${channelId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  async chatMessage(
    channelId: string,
    message: {
      id: string;
      content: string;
      /** Sanitized rich-text HTML (formatting toolbar). Optional. */
      htmlContent?: string;
      senderId: string;
      senderName: string;
      senderAvatar?: string;
      /** 'user' (default) or 'agent' — tells clients whether to render as AI */
      authorType?: string;
      threadId?: string;
      attachments?: Attachment[];
      forwardedFrom?: unknown;
    },
  ) {
    return this.chatPublish(channelId, {
      type: 'message',
      ...message,
      ts: Date.now(),
    });
  }

  async chatReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
    action: 'add' | 'remove',
  ) {
    return this.chatPublish(channelId, {
      type: 'reaction',
      messageId,
      emoji,
      userId,
      action,
    });
  }

  async chatPin(
    channelId: string,
    messageId: string,
    userId: string,
    action: 'pinned' | 'unpinned',
  ) {
    return this.chatPublish(channelId, { type: 'pin', messageId, userId, action });
  }

  async chatMember(
    channelId: string,
    userId: string,
    userName: string,
    action: 'joined' | 'left',
  ) {
    return this.chatPublish(channelId, { type: 'member', userId, userName, action });
  }

  async chatCall(
    channelId: string,
    callId: string,
    initiatorId: string,
    action: 'started' | 'ended',
  ) {
    return this.chatPublish(channelId, { type: 'call', callId, initiatorId, action });
  }

  async chatChannelUpdated(channelId: string, data: unknown) {
    return this.chatPublish(channelId, { type: 'channel:updated', data });
  }

  async chatMessageUpdated(
    channelId: string,
    data: { id: string; [key: string]: unknown },
  ) {
    // Shape matches the client-side RoomEvent 'message:updated' variant, which
    // reads fields off `event.data`. Spreading `...data` at the top level used
    // to break the client's subscriber — keep everything under `data`.
    return this.chatPublish(channelId, { type: 'message:updated', id: data.id, data });
  }

  async chatMessageDeleted(channelId: string, messageId: string) {
    return this.chatPublish(channelId, { type: 'message:deleted', id: messageId });
  }

  async chatCallParticipant(
    channelId: string,
    data: {
      callId: string;
      userId: string;
      userName: string;
      userAvatar?: string;
      cfSessionId?: string;
      action: 'joined' | 'left';
    },
  ) {
    return this.chatPublish(channelId, { type: 'call:participant', ...data });
  }

  async chatCallTrack(
    channelId: string,
    data: {
      callId: string;
      userId: string;
      trackName: string;
      trackType: string;
      action: 'added' | 'removed';
    },
  ) {
    return this.chatPublish(channelId, { type: 'call:track', ...data });
  }

  async chatReadUpdated(
    channelId: string,
    data: {
      channelId: string;
      userId: string;
      userName: string;
      userAvatar?: string;
      lastReadMessageId: string;
      lastReadAt: string;
    },
  ) {
    return this.chatPublish(channelId, { type: 'read:updated', ...data });
  }

  async chatClipTranscriptUpdated(
    channelId: string,
    data: { messageId: string; attachmentId: string; transcript: unknown },
  ) {
    return this.chatPublish(channelId, { type: 'clip:transcript:updated', ...data });
  }

  // ============================================
  // Chat User Events → WorkspaceHub DO
  // ============================================

  async chatUserChannelNew(
    workspaceId: string,
    userId: string,
    data: { channelId: string; channelName: string },
  ) {
    return this.publishPersonal(workspaceId, `chat.user.${userId}`, 'channel_new', data, userId);
  }

  async chatUserDmNew(
    workspaceId: string,
    userId: string,
    data: { channelId: string; senderName: string; preview: string },
  ) {
    return this.publishPersonal(workspaceId, `chat.user.${userId}`, 'dm_new', data, userId);
  }

  async chatUserMention(
    workspaceId: string,
    userId: string,
    data: { channelId: string; messageId: string; authorName: string; preview: string },
  ) {
    return this.publishPersonal(workspaceId, `chat.user.${userId}`, 'mention', data, userId);
  }

  async chatUserThreadReply(
    workspaceId: string,
    userId: string,
    data: { channelId: string; parentMessageId: string; replyMessageId: string; authorName: string; preview: string },
  ) {
    return this.publishPersonal(workspaceId, `chat.user.${userId}`, 'thread_reply', data, userId);
  }

  async chatUserUnreadUpdate(
    workspaceId: string,
    userId: string,
    data: { channelId: string; unreadCount: number },
  ) {
    return this.publishPersonal(workspaceId, `chat.user.${userId}`, 'unread_update', data, userId);
  }

  async chatCallIncoming(
    workspaceId: string,
    userId: string,
    data: {
      callId: string;
      channelId: string;
      callType: string;
      callerName: string;
      callerAvatar?: string;
    },
  ) {
    return this.publishPersonal(workspaceId, `chat.user.${userId}`, 'call_incoming', data, userId);
  }

  // ============================================
  // Workflow Execution Events → WorkspaceHub DO
  // ============================================

  async workflowExecutionEvent(
    workspaceId: string,
    executionId: string,
    event: string,
    data: unknown,
  ): Promise<void> {
    return this.publish(
      workspaceId,
      `workflow_execution.${executionId}`,
      event,
      data,
      'system',
    );
  }
}
