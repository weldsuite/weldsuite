/** Reply-inbox threads as rows of the shared conversation list, the one WeldMail's inbox uses. */

import type {
  ReachReplyLabel,
  ReachThreadSummary,
} from '@weldsuite/app-api-client/schemas/reach';
import type { ConversationItem } from '@/components/shared/conversation-list';
import { replyLabelKey } from '@/app/weldreach/components/engage/badges';
import { personName } from '@/app/weldreach/components/engage/format';
import { isUnread } from './thread-state';

// Chip colours follow the badge variants: green for a lead, red for a no, amber for later.
const GREEN = '#22C55E';
const RED = '#EF4444';
const AMBER = '#F59E0B';
const GREY = '#64748B';

const LABEL_COLORS: Record<ReachReplyLabel, string> = {
  interested: GREEN,
  meeting_request: GREEN,
  not_interested: RED,
  not_now: AMBER,
  out_of_office: GREY,
  wrong_person: GREY,
  unsubscribe: RED,
  other: GREY,
  unclassified: GREY,
};

const KINDS = {
  auto_reply: { key: 'reachEngage.kinds.auto_reply', color: GREY },
  bounce: { key: 'reachEngage.kinds.bounce', color: RED },
} as const;

export function threadToConversationItem(
  thread: ReachThreadSummary,
  t: (key: string) => string,
): ConversationItem {
  const { lastInbound, prospect } = thread;
  const unread = isUnread(thread);
  const labels: string[] = [];
  const labelColors: Record<string, string> = {};

  if (lastInbound.label && lastInbound.label !== 'unclassified') {
    const name = t(replyLabelKey(lastInbound.label));
    labels.push(name);
    labelColors[name] = LABEL_COLORS[lastInbound.label];
  }
  if (lastInbound.kind === 'auto_reply' || lastInbound.kind === 'bounce') {
    const { key, color } = KINDS[lastInbound.kind];
    const name = t(key);
    labels.push(name);
    labelColors[name] = color;
  }

  return {
    id: thread.threadKey,
    name: (prospect ? personName(prospect) : null) ?? prospect?.email ?? t('reachEngage.inbox.unknownSender'),
    email: prospect?.email,
    subject: lastInbound.subject ?? '',
    preview: lastInbound.snippet ?? '',
    date: new Date(lastInbound.receivedAt ?? 0),
    isRead: !unread,
    isStarred: false,
    hasAttachments: false,
    labels,
    labelColors,
    messageCount: thread.messageCount,
    unreadCount: unread ? 1 : 0,
  };
}
