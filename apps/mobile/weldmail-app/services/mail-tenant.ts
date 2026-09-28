/**
 * Tenant-aware mail helpers for WeldMail.
 *
 * Workspace mail lives on app-api (org-scoped JWT). Personal mail lives on
 * personal-api (user-scoped; org claim is ignored). The UI treats both as
 * one mailbox list; this module picks the right client and remembers which
 * ids belong to the personal tenant so offline flush / detail screens can
 * route without threading tenantKind through every call site.
 */

import type { MailMessageRow } from '@weldsuite/app-api-client/domains/mail-messages';
import type { SendMailMessageInput } from '@weldsuite/app-api-client';
import type { MailMessage as PersonalMailMessage } from '@weldsuite/personal-api-client';
import { appApi } from '@/services/app-api';
import { personalApi } from '@/services/personal-api';
import type { EmailListItem } from '@/types/mail';

export type TenantKind = 'workspace' | 'personal';

export interface TenantMailAccount {
  id: string;
  emailAddress: string;
  displayName: string;
  provider?: string;
  isDefault?: boolean;
  isActive?: boolean;
  tenantKind: TenantKind;
  clerkOrgId?: string | null;
  workspaceName?: string | null;
}

const personalAccountIds = new Set<string>();
const personalMessageIds = new Set<string>();

export function rememberPersonalAccounts(ids: string[]): void {
  personalAccountIds.clear();
  for (const id of ids) personalAccountIds.add(id);
}

export function rememberPersonalMessages(ids: string[]): void {
  for (const id of ids) personalMessageIds.add(id);
}

export function isPersonalAccountId(id?: string | null): boolean {
  return !!id && personalAccountIds.has(id);
}

export function isPersonalMessage(messageId: string, accountId?: string | null): boolean {
  if (accountId && personalAccountIds.has(accountId)) return true;
  return personalMessageIds.has(messageId);
}

export function isPersonalAccount(account: { tenantKind?: TenantKind } | null | undefined): boolean {
  return account?.tenantKind === 'personal';
}

function asIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** Map a personal-api message onto the list/detail shape the inbox already uses. */
export function normalizePersonalMessage(row: PersonalMailMessage): EmailListItem {
  rememberPersonalMessages([row.id]);
  const sent = asIso(row.sentDate);
  const received = asIso(row.receivedDate);
  const created = asIso(row.createdAt) ?? sent ?? new Date().toISOString();
  const updated = asIso(row.updatedAt) ?? created;
  return {
    id: row.id,
    accountId: row.accountId,
    messageId: row.messageId,
    threadId: row.threadId ?? null,
    from: row.from ? { email: row.from.email, name: row.from.name ?? null } : null,
    to: (row.to ?? []).map((a) => ({ email: a.email, name: a.name ?? null })),
    cc: (row.cc ?? []).map((a) => ({ email: a.email, name: a.name ?? null })),
    bcc: (row.bcc ?? []).map((a) => ({ email: a.email, name: a.name ?? null })),
    replyTo: row.replyTo ? { email: row.replyTo.email, name: row.replyTo.name ?? null } : null,
    subject: row.subject ?? null,
    preview: row.preview ?? null,
    textBody: row.textBody ?? null,
    htmlBody: row.htmlBody ?? null,
    sentDate: sent,
    receivedDate: received,
    isRead: !!row.isRead,
    isStarred: !!row.isStarred,
    isFlagged: false,
    isImportant: false,
    isDraft: !!row.isDraft,
    isReply: false,
    hasAttachments: !!row.hasAttachments,
    attachmentCount: 0,
    priority: null,
    labels: row.labels ?? null,
    sizeBytes: null,
    scheduledFor: null,
    sendStatus: row.sendStatus ?? null,
    source: row.source ?? null,
    inReplyTo: null,
    references: null,
    externalMessageId: null,
    createdAt: created,
    updatedAt: updated,
    deletedAt: null,
  };
}

export function mergeByDate<T extends { sentDate?: string | null; receivedDate?: string | null; createdAt?: string }>(
  a: T[],
  b: T[],
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of [...a, ...b]) {
    const id = (item as { id?: string }).id;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    merged.push(item);
  }
  merged.sort((x, y) => {
    const dx = Date.parse(x.sentDate || x.receivedDate || x.createdAt || '') || 0;
    const dy = Date.parse(y.sentDate || y.receivedDate || y.createdAt || '') || 0;
    return dy - dx;
  });
  return merged;
}

function sentDateOf(row: MailMessageRow | EmailListItem): number {
  return Date.parse(row.sentDate || row.receivedDate || row.createdAt || '') || 0;
}

/**
 * Where the inbox list stopped. Unified mode reads two independent streams
 * (workspace mail on app-api, personal mail on personal-api), so it carries a
 * server cursor for each. `undefined` means "start from the newest"; a `*Done`
 * flag means that stream has nothing left. Treat it as opaque outside this file.
 */
export interface InboxCursor {
  workspace?: string;
  personal?: string;
  workspaceDone?: boolean;
  personalDone?: boolean;
}

export interface InboxPage {
  items: EmailListItem[];
  /** Pass back to fetch the next page; `null` once everything is loaded. */
  cursor: InboxCursor | null;
}

interface SourcePage {
  rows: EmailListItem[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * One page of the inbox, newest first. Search runs server-side on both
 * backends, so it covers the whole mailbox rather than the loaded rows.
 */
export async function listInboxMessagesPage(opts: {
  isUnified: boolean;
  selected?: TenantMailAccount | null;
  label?: string;
  search?: string;
  limit?: number;
  cursor?: InboxCursor | null;
}): Promise<InboxPage> {
  const limit = opts.limit ?? 50;
  const label = opts.label;
  const search = opts.search?.trim() || undefined;
  const cursor = opts.cursor ?? {};

  if (!opts.isUnified && opts.selected && isPersonalAccount(opts.selected)) {
    const { data, pagination } = await personalApi.mailMessages.list({
      accountId: opts.selected.id,
      label,
      search,
      limit,
      cursor: cursor.personal,
    });
    return {
      items: data.map(normalizePersonalMessage),
      cursor: pagination?.hasMore && pagination.cursor ? { personal: pagination.cursor } : null,
    };
  }

  if (!opts.isUnified && opts.selected) {
    const { data, pagination } = await appApi.mailMessages.list({
      accountId: opts.selected.id,
      label,
      search,
      limit,
      cursor: cursor.workspace,
    });
    return {
      items: data as EmailListItem[],
      cursor: pagination?.hasMore && pagination.cursor ? { workspace: pagination.cursor } : null,
    };
  }

  // Unified: current workspace (if the JWT has an org) + personal.
  const wantWorkspace = !cursor.workspaceDone;
  const wantPersonal = !cursor.personalDone && personalAccountIds.size > 0;
  const [workspace, personal] = await Promise.allSettled([
    wantWorkspace
      ? appApi.mailMessages
          .list({ label, search, limit, cursor: cursor.workspace })
          .then((r): SourcePage => ({
            rows: r.data as EmailListItem[],
            cursor: r.pagination?.cursor ?? null,
            hasMore: !!r.pagination?.hasMore,
          }))
      : Promise.resolve(null),
    wantPersonal
      ? personalApi.mailMessages
          .list({ label, search, limit, cursor: cursor.personal })
          .then((r): SourcePage => ({
            rows: r.data.map(normalizePersonalMessage),
            cursor: r.pagination?.cursor ?? null,
            hasMore: !!r.pagination?.hasMore,
          }))
      : Promise.resolve(null),
  ]);

  // Nothing came back at all: surface the error so the caller keeps what is
  // on screen instead of treating a failed request as the end of the list.
  const attempted = [wantWorkspace && workspace, wantPersonal && personal].filter(
    (r): r is PromiseSettledResult<SourcePage | null> => !!r,
  );
  if (attempted.length > 0 && attempted.every((r) => r.status === 'rejected')) {
    throw (attempted[0] as PromiseRejectedResult).reason;
  }

  // A source that errors (no org on the JWT, personal-api down) is skipped
  // for the rest of this list, as the single-page inbox always did.
  const ws = workspace.status === 'fulfilled' ? workspace.value : null;
  const ps = personal.status === 'fulfilled' ? personal.value : null;

  return mergeInboxSources(
    limit,
    { page: ws, cursor: cursor.workspace, done: !wantWorkspace || !ws },
    { page: ps, cursor: cursor.personal, done: !wantPersonal || !ps },
  );
}

interface SourceState {
  page: SourcePage | null;
  /** Cursor this page was fetched from. */
  cursor: string | undefined;
  done: boolean;
}

/**
 * Interleave one page from each unified source into a single newest-first
 * page. Only `limit` rows are shown; whatever was fetched but not shown is
 * fetched again next time (each source's cursor stops at its last shown
 * row), so an older workspace row is never listed above a newer personal row
 * that simply arrived on a later page.
 */
export function mergeInboxSources(
  limit: number,
  workspace: SourceState,
  personal: SourceState,
): InboxPage {
  const merged = mergeByDate(workspace.page?.rows ?? [], personal.page?.rows ?? []);
  const items = merged.slice(0, limit);
  const shown = new Set(items.map((m) => m.id));
  const allShown = merged.length <= limit;

  const advance = (src: SourceState): { cursor?: string; done: boolean } => {
    if (src.done || !src.page) return { cursor: src.cursor, done: true };
    const { rows } = src.page;
    let last = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (shown.has(rows[i]!.id)) { last = i; break; }
    }
    if (allShown || last === rows.length - 1) {
      return src.page.hasMore && src.page.cursor
        ? { cursor: src.page.cursor, done: false }
        : { cursor: src.page.cursor ?? undefined, done: true };
    }
    // Some of this page is still unshown: resume right after the last shown row.
    return { cursor: last >= 0 ? rows[last]!.id : src.cursor, done: false };
  };

  const w = advance(workspace);
  const p = advance(personal);
  if (w.done && p.done) return { items, cursor: null };
  return {
    items,
    cursor: {
      workspace: w.cursor,
      personal: p.cursor,
      workspaceDone: w.done,
      personalDone: p.done,
    },
  };
}

export async function getMessage(id: string): Promise<EmailListItem> {
  if (isPersonalMessage(id)) {
    const { data } = await personalApi.mailMessages.get(id);
    return normalizePersonalMessage(data);
  }
  try {
    const { data } = await appApi.mailMessages.get(id);
    return data as EmailListItem;
  } catch (err) {
    const { data } = await personalApi.mailMessages.get(id);
    return normalizePersonalMessage(data);
  }
}

export async function markMessageRead(id: string): Promise<void> {
  if (isPersonalMessage(id)) {
    await personalApi.mailMessages.patch(id, { isRead: true });
    return;
  }
  try {
    await appApi.mailMessages.update(id, { isRead: true });
  } catch {
    await personalApi.mailMessages.patch(id, { isRead: true });
    rememberPersonalMessages([id]);
  }
}

export async function getThread(id: string): Promise<MailMessageRow[]> {
  if (isPersonalMessage(id)) {
    const { data } = await personalApi.mailMessages.get(id);
    return [normalizePersonalMessage(data)];
  }
  try {
    const { data } = await appApi.mailMessages.thread(id);
    return data.messages;
  } catch {
    const { data } = await personalApi.mailMessages.get(id);
    rememberPersonalMessages([id]);
    return [normalizePersonalMessage(data)];
  }
}

export async function listLabelsForAccount(account: TenantMailAccount) {
  if (isPersonalAccount(account)) {
    const { data } = await personalApi.mailLabels.list(account.id);
    return data;
  }
  const { data } = await appApi.mailLabels.list({ accountId: account.id });
  return data;
}

export async function sendFromAccount(account: TenantMailAccount, payload: SendMailMessageInput) {
  if (isPersonalAccount(account) || isPersonalAccountId(account.id)) {
    return personalApi.mailMessages.send({
      accountId: account.id,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject ?? '',
      textBody: payload.body,
      htmlBody: payload.htmlBody,
      inReplyTo: payload.inReplyTo,
      idempotencyKey: payload.idempotencyKey,
    });
  }
  return appApi.mailAccounts.send(account.id, payload);
}

export async function createDraft(opts: {
  accountId: string;
  tenantKind?: TenantKind;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
}) {
  if (opts.tenantKind === 'personal' || isPersonalAccountId(opts.accountId)) {
    return personalApi.mailDrafts.create({
      accountId: opts.accountId,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      body: opts.body,
      htmlBody: opts.htmlBody,
    });
  }
  return appApi.mailDrafts.create({
    accountId: opts.accountId,
    to: opts.to,
    cc: opts.cc,
    bcc: opts.bcc,
    subject: opts.subject,
    body: opts.body,
    htmlBody: opts.htmlBody,
  });
}

export async function deleteDraft(id: string, accountId?: string) {
  if (isPersonalAccountId(accountId) || isPersonalMessage(id)) {
    await personalApi.mailDrafts.delete(id);
    return;
  }
  try {
    await appApi.mailDrafts.delete(id);
  } catch {
    await personalApi.mailDrafts.delete(id);
  }
}

export async function listDrafts(opts: { accountId?: string; isUnified: boolean; selected?: TenantMailAccount | null }) {
  if (!opts.isUnified && opts.selected && isPersonalAccount(opts.selected)) {
    return personalApi.mailDrafts.list({ accountId: opts.selected.id });
  }
  if (!opts.isUnified && opts.accountId && isPersonalAccountId(opts.accountId)) {
    return personalApi.mailDrafts.list({ accountId: opts.accountId });
  }

  // A single workspace mailbox only has workspace drafts: listing every
  // personal draft alongside inflated its Drafts count and list.
  const includePersonal = personalAccountIds.size > 0 && (opts.isUnified || !opts.accountId);
  const [workspace, personal] = await Promise.allSettled([
    appApi.mailDrafts.list(opts.accountId ? { accountId: opts.accountId } : {}),
    includePersonal ? personalApi.mailDrafts.list({}) : Promise.resolve({ data: [] }),
  ]);
  const ws = workspace.status === 'fulfilled' ? workspace.value.data : [];
  const pe = personal.status === 'fulfilled' ? personal.value.data : [];
  return { data: [...ws, ...pe] };
}

export async function applyMessageLabels(
  messageId: string,
  addLabels: string[],
  removeLabels: string[],
  current: string[],
): Promise<string[]> {
  if (isPersonalMessage(messageId)) {
    const next = [...current.filter((l) => !removeLabels.includes(l)), ...addLabels];
    const unique = Array.from(new Set(next));
    await personalApi.mailMessages.patch(messageId, { labels: unique });
    return unique;
  }
  let finalLabels = current;
  if (addLabels.length > 0) {
    const res = await appApi.mailMessages.addLabels(messageId, { labels: addLabels });
    finalLabels = res.data.labels;
  }
  if (removeLabels.length > 0) {
    const res = await appApi.mailMessages.removeLabels(messageId, { labels: removeLabels });
    finalLabels = res.data.labels;
  }
  return finalLabels;
}

export { sentDateOf };

// =============================================================================
// Subscriptions (mailing lists + unsubscribe)
// =============================================================================

export type SubscriptionMethod = 'one_click' | 'mailto' | 'link';

/** Tenant-neutral subscription row for the Subscriptions screen. */
export interface TenantSubscription {
  id: string;
  accountId: string;
  senderEmail: string;
  senderName: string | null;
  lastSubject: string | null;
  messageCount: number;
  lastReceivedAt: string;
  status: 'active' | 'unsubscribed';
  unsubscribedAt: string | null;
  unsubscribeUrl: string | null;
  unsubscribeMailto: string | null;
  oneClick: boolean;
}

function toTenantSubscription(row: TenantSubscription): TenantSubscription {
  return {
    id: row.id,
    accountId: row.accountId,
    senderEmail: row.senderEmail,
    senderName: row.senderName,
    lastSubject: row.lastSubject,
    messageCount: row.messageCount,
    lastReceivedAt: row.lastReceivedAt,
    status: row.status,
    unsubscribedAt: row.unsubscribedAt,
    unsubscribeUrl: row.unsubscribeUrl,
    unsubscribeMailto: row.unsubscribeMailto,
    oneClick: row.oneClick,
  };
}

export async function listSubscriptions(account: TenantMailAccount): Promise<TenantSubscription[]> {
  const { data } = isPersonalAccount(account)
    ? await personalApi.mailSubscriptions.list({ accountId: account.id })
    : await appApi.mailSubscriptions.list({ accountId: account.id });
  return data.map(toTenantSubscription);
}

export async function scanSubscriptions(account: TenantMailAccount): Promise<{ scanned: number; subscriptions: number }> {
  const { data } = isPersonalAccount(account)
    ? await personalApi.mailSubscriptions.scan(account.id)
    : await appApi.mailSubscriptions.scan({ accountId: account.id });
  return data;
}

export async function unsubscribeFromSender(
  account: TenantMailAccount,
  subscriptionId: string,
): Promise<{ method: SubscriptionMethod; url: string | null }> {
  const { data } = isPersonalAccount(account)
    ? await personalApi.mailSubscriptions.unsubscribe(subscriptionId)
    : await appApi.mailSubscriptions.unsubscribe(subscriptionId);
  return { method: data.method, url: data.url };
}

/** Only a plain https link: the sender's page has to be opened to finish. */
export function isLinkOnlySubscription(sub: Pick<TenantSubscription, 'unsubscribeUrl' | 'unsubscribeMailto' | 'oneClick'>): boolean {
  return !!sub.unsubscribeUrl && !sub.oneClick && !sub.unsubscribeMailto;
}
