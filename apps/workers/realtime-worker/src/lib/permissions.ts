import type { AuthInfo, WorkspacePermissions, RoomPermissions } from './protocol';

/**
 * Topic prefixes that are scoped per-user. The DO enforces that a connection
 * may only subscribe to `<prefix>.<own-userId>[...]` — never another user's
 * suffix, regardless of role. This is the subscribe-side half of the
 * personal-topic isolation guarantee; the publisher half attaches
 * `_access: { userIds: [target] }` for defence-in-depth.
 */
export const PERSONAL_TOPIC_PREFIXES = [
  'notification',
  'mail',
  'inbox',
  'chat.user',
] as const;

/**
 * Determine which WorkspaceHub topics a user can subscribe to.
 *
 * Personal topics are returned ONLY in their user-scoped form
 * (`notification.<userId>`, `mail.<userId>`, …) — never as bare prefixes —
 * because `canSubscribe`'s prefix-match semantics would otherwise let a
 * subscriber tap any other user's personal stream.
 */
export function getWorkspacePermissions(auth: AuthInfo): WorkspacePermissions {
  const personalTopics = [
    `notification.${auth.userId}`,
    `mail.${auth.userId}`,
    `inbox.${auth.userId}`,
    `chat.user.${auth.userId}`,
  ];

  // Owners and admins get full access EXCEPT other users' personal streams,
  // which are enforced separately at subscribe time via
  // `isPersonalTopicForOtherUser`. Keep `*` here so the wildcard still grants
  // every non-personal topic without listing them all.
  if (auth.role === 'owner' || auth.role === 'admin') {
    return { subscribe: ['*'] };
  }

  // Regular members get most topics
  if (auth.role === 'member') {
    return {
      subscribe: [
        ...personalTopics,
        'project',
        'task',
        'contact',
        'company',
        'person',
        'lead',
        'opportunity',
        'product',
        'inventory',
        'invoice',
        'bill',
        'payment',
        'commerce_order',
        'ticket',
        'helpdesk',
        'presence',
      ],
    };
  }

  // Viewers get read-only subset
  return {
    subscribe: [...personalTopics, 'project', 'task', 'presence'],
  };
}

/**
 * Return true when `topic` is a personal topic whose target is NOT the
 * caller. Used by the WorkspaceHub subscribe handler to reject attempts
 * like `notification.<some-other-user-id>`, including for admins/owners
 * whose role allow list is `*`.
 *
 * Semantics:
 *   - Bare `notification` / `mail` / `inbox` / `chat.user`: always blocked
 *     (no user can claim ownership of the family-wide stream).
 *   - `<prefix>.<segment>[...]`: blocked when the first segment after the
 *     prefix is not the caller's userId. Sub-paths under the user's own
 *     suffix (`notification.<me>.foo`) remain allowed.
 *   - Non-personal topics: always allowed (this guard returns false and
 *     defers to the role allow list).
 */
export function isPersonalTopicForOtherUser(
  authUserId: string,
  topic: string,
): boolean {
  for (const prefix of PERSONAL_TOPIC_PREFIXES) {
    if (topic === prefix) return true;
    if (topic.startsWith(prefix + '.')) {
      const after = topic.slice(prefix.length + 1);
      const nextSegment = after.split('.', 1)[0];
      if (nextSegment !== authUserId) return true;
    }
  }
  return false;
}

/**
 * Determine permissions for a ConversationRoom connection.
 */
export function getConversationPermissions(
  auth: AuthInfo,
  conversationId: string,
): RoomPermissions {
  if (auth.type === 'agent') {
    return { canPublish: true, role: 'agent' };
  }

  if (auth.type === 'customer') {
    // Customers can only publish to their own conversation
    if (auth.conversationId === conversationId) {
      return { canPublish: true, role: 'customer' };
    }
    return { canPublish: false, role: 'viewer' };
  }

  return { canPublish: false, role: 'viewer' };
}

/**
 * Determine permissions for a ChatRoom connection.
 */
export function getChatPermissions(auth: AuthInfo, _channelId: string): RoomPermissions {
  // All authenticated workspace members can publish to chat
  if (auth.type === 'agent') {
    return { canPublish: true, role: 'member' };
  }

  return { canPublish: false, role: 'viewer' };
}

/**
 * Check if a topic subscription is allowed given the user's permissions.
 */
export function canSubscribe(allowed: string[], topic: string): boolean {
  return allowed.some((pattern) => {
    if (pattern === '*') return true;
    // "project" allows "project" and "project.proj_123"
    return topic === pattern || topic.startsWith(pattern + '.');
  });
}
