/**
 * Helpers for WeldMail list / message URLs.
 *
 * The label layouts read `page` from the query string to fetch the thread list.
 * Opening a message must keep that param, otherwise the list jumps back to page 1.
 */

export function buildMailSearch(params: {
  page?: number;
  accountId?: string;
}): string {
  const usp = new URLSearchParams();
  if (params.accountId) usp.set('accountId', params.accountId);
  if (params.page != null && params.page > 1) usp.set('page', String(params.page));
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

export function mailFolderPath(folder: string): string {
  return folder.toLowerCase() === 'inbox' ? 'inbox' : folder.toLowerCase();
}

export function buildMailItemUrl(opts: {
  isUnified: boolean;
  accountId: string;
  folder: string;
  messageId: string;
  threadAccountId?: string;
  page?: number;
}): string {
  const folderPath = mailFolderPath(opts.folder);
  const base = opts.isUnified
    ? `/weldmail/unified/${folderPath}`
    : `/weldmail/${opts.accountId}/${folderPath}`;
  return `${base}/${opts.messageId}${buildMailSearch({
    page: opts.page,
    accountId: opts.isUnified ? opts.threadAccountId : undefined,
  })}`;
}

export function buildMailListUrl(opts: {
  isUnified: boolean;
  accountId: string;
  folder: string;
  page?: number;
}): string {
  const folderPath = mailFolderPath(opts.folder);
  const base = opts.isUnified
    ? `/weldmail/unified/${folderPath}`
    : `/weldmail/${opts.accountId}/${folderPath}`;
  return `${base}${buildMailSearch({ page: opts.page })}`;
}

export function parseMailSearch(search: Record<string, unknown>): {
  page?: number;
  accountId?: string;
} {
  const pageNum = Number(search.page);
  return {
    page: Number.isFinite(pageNum) && pageNum > 1 ? pageNum : undefined,
    accountId: typeof search.accountId === 'string' && search.accountId ? search.accountId : undefined,
  };
}

export function currentMailHref(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}`;
}
