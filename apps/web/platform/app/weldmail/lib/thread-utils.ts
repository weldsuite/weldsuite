/**
 * Thread utility functions for Gmail-style conversation grouping.
 *
 * ThreadId is computed from RFC 5322 headers (messageId, inReplyTo, references)
 * and stored in the database for efficient querying.
 */

/**
 * Thread summary interface representing a grouped conversation
 */
export interface ThreadSummary {
  threadId: string;
  subject: string; // Cleaned subject (no Re:/Fwd:)
  participants: string[]; // All unique senders
  latestMessageId: string; // ID of most recent message
  latestSender: string; // Sender of most recent message
  latestSenderEmail: string; // Email of most recent sender
  /**
   * Avatar URL for the latest sender, resolved server-side from the shared
   * `contacts` table by email match. Null when the sender isn't in contacts —
   * UI falls back to the deterministic-initials renderer.
   */
  latestSenderAvatarUrl?: string | null;
  latestDate: Date; // Date of most recent message
  preview: string; // Preview from latest message
  messageCount: number; // Total messages in thread
  unreadCount: number; // Number of unread messages
  hasAttachments: boolean; // Any message has attachments
  isStarred: boolean; // Any message is starred
  labels: string[]; // Union of all message labels
  scheduledFor?: string | Date | null; // Scheduling time
  sendStatus?: string | null; // 'scheduled' | 'sent' | 'cancelled'
  messages: any[]; // All messages in thread (for detail view)
  accountId?: string; // Present in unified view
  accountEmail?: string; // Present in unified view
  accountDisplayName?: string; // Present in unified view
}

/**
 * Compute threadId for a message based on RFC 5322 headers.
 *
 * Algorithm:
 * 1. If `references` array exists and has entries, use the first entry (root of conversation)
 * 2. Else if `inReplyTo` exists, use that as threadId
 * 3. Else use the message's own `messageId` (this is a new/standalone thread)
 *
 * @param message - Message with RFC 5322 headers
 * @returns The computed threadId
 */
export function computeThreadId(message: {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[] | null;
}): string {
  // References array contains all ancestor message IDs, first one is the root
  if (message.references && Array.isArray(message.references) && message.references.length > 0) {
    return message.references[0];
  }

  // inReplyTo points to the immediate parent - use it as threadId
  // (Note: This means replies to the same message share threadId)
  if (message.inReplyTo) {
    return message.inReplyTo;
  }

  // No threading info - this message starts its own thread
  return message.messageId;
}

/**
 * Normalize email subject by removing common prefixes.
 *
 * Removes: Re:, Fwd:, FW:, RE:, Fw: and their variations
 * Also handles multiple prefixes like "Re: Re: Fwd: Subject"
 *
 * @param subject - Original subject line
 * @returns Cleaned subject without prefixes
 */
export function normalizeSubject(subject: string): string {
  if (!subject) return '(no subject)';

  // Pattern matches Re:, Fwd:, FW:, RE:, Fw: etc. at the start
  // Also handles multiple prefixes and optional spaces
  const prefixPattern = /^(\s*(re|fwd|fw)\s*:\s*)+/i;

  return subject.replace(prefixPattern, '').trim() || '(no subject)';
}

/**
 * Group messages into threads and compute thread metadata.
 *
 * @param messages - Array of messages (must have threadId populated)
 * @returns Array of ThreadSummary objects sorted by latest message date
 */
export function groupMessagesIntoThreads(messages: any[]): ThreadSummary[] {
  // Group messages by threadId
  const threadMap = new Map<string, any[]>();

  for (const msg of messages) {
    const threadId = msg.threadId || computeThreadId(msg);
    const existing = threadMap.get(threadId) || [];
    existing.push(msg);
    threadMap.set(threadId, existing);
  }

  // Convert to ThreadSummary array
  const threads: ThreadSummary[] = [];

  for (const [threadId, threadMessages] of threadMap) {
    // Sort messages by date (oldest first within thread)
    threadMessages.sort(
      (a, b) =>
        new Date(a.receivedDate || a.sentDate || a.createdAt).getTime() -
        new Date(b.receivedDate || b.sentDate || b.createdAt).getTime()
    );

    const firstMessage = threadMessages[0];
    const latestMessage = threadMessages[threadMessages.length - 1];

    // Collect unique participants (senders)
    const participantSet = new Set<string>();
    for (const msg of threadMessages) {
      const sender =
        typeof msg.from === 'object' ? msg.from?.name || msg.from?.email : msg.fromName || msg.from;
      if (sender) participantSet.add(sender);
    }

    // Compute aggregate values
    const unreadCount = threadMessages.filter((m: any) => !m.isRead).length;
    const hasAttachments = threadMessages.some((m: any) => m.hasAttachments);
    const isStarred = threadMessages.some((m: any) => m.isStarred);

    // Collect all labels (union)
    const labelSet = new Set<string>();
    for (const msg of threadMessages) {
      if (msg.labels && Array.isArray(msg.labels)) {
        msg.labels.forEach((l: string) => labelSet.add(l));
      }
    }

    // Get sender info from latest message
    const latestSender =
      typeof latestMessage.from === 'object'
        ? latestMessage.from?.name || latestMessage.from?.email
        : latestMessage.fromName || latestMessage.from || 'Unknown';
    const latestSenderEmail =
      typeof latestMessage.from === 'object'
        ? latestMessage.from?.email
        : latestMessage.fromEmail || latestMessage.from || '';

    threads.push({
      threadId,
      subject: normalizeSubject(firstMessage.subject),
      participants: Array.from(participantSet),
      latestMessageId: latestMessage.id,
      latestSender,
      latestSenderEmail,
      latestDate: new Date(
        latestMessage.receivedDate || latestMessage.sentDate || latestMessage.createdAt
      ),
      preview: latestMessage.preview || latestMessage.textBody?.substring(0, 150) || '',
      messageCount: threadMessages.length,
      unreadCount,
      hasAttachments,
      isStarred,
      labels: Array.from(labelSet),
      messages: threadMessages,
    });
  }

  // Sort threads by latest message date (newest first)
  threads.sort((a, b) => b.latestDate.getTime() - a.latestDate.getTime());

  return threads;
}

/**
 * Get avatar color based on name (consistent hashing)
 */
export function getThreadAvatarColor(name: string): string {
  const colors = [
    '#4F46E5',
    '#7C3AED',
    '#EC4899',
    '#EF4444',
    '#F97316',
    '#EAB308',
    '#22C55E',
    '#14B8A6',
    '#06B6D4',
    '#3B82F6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

/**
 * Format participants list for display.
 * Shows up to 2 names, then "+N" for additional.
 *
 * @param participants - Array of participant names
 * @returns Formatted string like "John, Jane +2"
 */
export function formatParticipants(participants: string[]): string {
  if (participants.length === 0) return 'Unknown';
  if (participants.length === 1) return participants[0];
  if (participants.length === 2) return `${participants[0]}, ${participants[1]}`;
  return `${participants[0]}, ${participants[1]} +${participants.length - 2}`;
}
