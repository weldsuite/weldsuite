/**
 * Helpers for WeldMail list / message URLs.
 *
 * The thread list uses infinite scroll, so `page` is no longer required for
 * browsing. `accountId` is still kept on unified message deep-links so the
 * detail pane opens the right mailbox.
 */

import { stripWorkspacePrefix } from '@/lib/workspace-url';

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

/**
 * An in-app path as an absolute URL on this origin, for places that leave the
 * app (a task description that links back to the mail). Without an origin
 * (tests, SSR) the path is returned as it is.
 */
export function absoluteMailUrl(path: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return `${base}${path}`;
}

/** The in-app path and query of this page, for a return URL the router navigates back to. */
export function currentMailHref(): string {
  if (typeof window === 'undefined') return '';
  return `${stripWorkspacePrefix(window.location.pathname)}${window.location.search}`;
}
