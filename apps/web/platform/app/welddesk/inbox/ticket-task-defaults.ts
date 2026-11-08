import type { DeskConversation, DeskMessage } from '@/hooks/queries/use-desk-queries';

/** `createTaskSchema.title` takes at most 500 characters. */
const MAX_TITLE = 500;

/** The newest message the customer wrote, if any. */
export function latestCustomerMessage(messages: readonly DeskMessage[]): DeskMessage | undefined {
  return messages.findLast((m) => m.kind === 'message' && m.authorType === 'visitor' && !!m.body?.trim());
}

function firstLine(text: string | null | undefined): string {
  return text?.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/**
 * The task a ticket starts with: `#<number> <subject>` (or the first line of
 * the customer's latest message when there is no subject), described by that
 * message.
 */
export function ticketTaskDefaults(
  conversation: Pick<DeskConversation, 'conversationNumber' | 'title' | 'name' | 'email'>,
  messages: readonly DeskMessage[],
  labels: { latestCustomerMessage: string },
): { title: string; description: string } {
  const latest = latestCustomerMessage(messages);
  const subject =
    conversation.title?.trim() || firstLine(latest?.body) || conversation.name || conversation.email || '';
  const title = `#${conversation.conversationNumber} ${subject}`.trim().slice(0, MAX_TITLE);
  const body = latest?.body?.trim();
  const description = body ? `${labels.latestCustomerMessage}:\n\n${body}` : '';
  return { title, description };
}
