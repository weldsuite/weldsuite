import type { ListMailMessagesQuery, MailMessageRow } from '@weldsuite/app-api-client';
import { buildMailItemUrl } from '../lib/mail-urls';

/** Page size for the cross-mailbox search (the API caps `limit` at 100). */
export const MAIL_SEARCH_PAGE_SIZE = 25;

/** Debounce (ms) between the last keystroke and the search request. */
export const MAIL_SEARCH_DEBOUNCE_MS = 300;

export interface MailSearchFilters {
  hasAttachments: boolean;
  isStarred: boolean;
}

/** An empty or whitespace-only query never reaches the server. */
export function normalizeSearchQuery(query: string): string {
  return query.trim();
}

/**
 * Request params for `GET /api/mail-messages`. Boolean filters are only sent when
 * switched on: the API coerces the string "false" to `true`, so "off" must be omitted.
 */
export function buildMailSearchParams(opts: {
  query: string;
  filters: MailSearchFilters;
  cursor?: string;
}): Partial<ListMailMessagesQuery> {
  const params: Partial<ListMailMessagesQuery> = {
    search: normalizeSearchQuery(opts.query),
    limit: MAIL_SEARCH_PAGE_SIZE,
  };
  if (opts.filters.hasAttachments) params.hasAttachments = true;
  if (opts.filters.isStarred) params.isStarred = true;
  if (opts.cursor) params.cursor = opts.cursor;
  return params;
}

/** Mailboxes in the order a message is most naturally "found" in. */
const FOLDER_BY_LABEL: ReadonlyArray<readonly [label: string, folder: string]> = [
  ['TRASH', 'trash'],
  ['SPAM', 'spam'],
  ['DRAFTS', 'drafts'],
  ['DRAFT', 'drafts'],
  ['SENT', 'sent'],
  ['INBOX', 'inbox'],
  ['ARCHIVE', 'archive'],
];

/** The mailbox a message lives in, derived from its system labels ("all" when it has none). */
export function pickResultFolder(labels: readonly string[] | null | undefined): string {
  const set = new Set((labels ?? []).map((label) => label.toUpperCase()));
  for (const [label, folder] of FOLDER_BY_LABEL) {
    if (set.has(label)) return folder;
  }
  return 'all';
}

export interface MailSearchResult {
  id: string;
  accountId: string;
  /** Display name of the sender, falling back to the address. Empty when unknown. */
  from: string;
  subject: string;
  preview: string;
  date: Date | null;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  folder: string;
  href: string;
}

export function toMailSearchResult(row: MailMessageRow): MailSearchResult {
  const folder = pickResultFolder(row.labels);
  const dateValue = row.receivedDate ?? row.sentDate ?? row.createdAt;
  const date = dateValue ? new Date(dateValue) : null;
  return {
    id: row.id,
    accountId: row.accountId,
    from: row.from?.name || row.from?.email || '',
    subject: row.subject ?? '',
    preview: row.preview ?? '',
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    isRead: row.isRead ?? false,
    isStarred: row.isStarred ?? false,
    hasAttachments: row.hasAttachments ?? false,
    folder,
    href: buildMailItemUrl({
      isUnified: false,
      accountId: row.accountId,
      folder,
      messageId: row.id,
    }),
  };
}
