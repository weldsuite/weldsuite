import type { MailMessageStats } from '@weldsuite/app-api-client/domains/mail-messages';

/**
 * Sidebar badge per folder slug, summed over the mailboxes in view (one
 * account, or all of them in the unified inbox). Folders at zero get no entry.
 *
 * Most folders show their unread mail. Starred, Drafts, Scheduled, Snoozed and
 * Spam show everything in them: none of those has a meaningful "unread".
 */
export function folderCountsFromStats(
  stats: Array<Partial<MailMessageStats> | null | undefined>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (slug: string, value: number | undefined) => {
    if (value && value > 0) counts[slug] = (counts[slug] ?? 0) + value;
  };
  for (const s of stats) {
    if (!s) continue;
    add('inbox', s.inboxUnread);
    add('starred', s.starred);
    add('sent', s.sentUnread);
    add('drafts', s.drafts);
    add('scheduled', s.scheduled);
    add('snoozed', s.snoozed);
    add('important', s.importantUnread);
    add('archive', s.archiveUnread);
    add('spam', s.spam);
    add('trash', s.trashUnread);
  }
  return counts;
}
