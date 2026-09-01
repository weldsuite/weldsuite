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

export async function listInboxMessages(opts: {
  isUnified: boolean;
  selected?: TenantMailAccount | null;
  label?: string;
  search?: string;
  limit?: number;
}): Promise<EmailListItem[]> {
  const limit = opts.limit ?? 50;
  const label = opts.label;
  const search = opts.search;

  if (!opts.isUnified && opts.selected && isPersonalAccount(opts.selected)) {
    const { data } = await personalApi.mailMessages.list({
      accountId: opts.selected.id,
      label,
      limit,
    });
    let rows = data.map(normalizePersonalMessage);
    if (search) rows = filterSearch(rows, search);
    return rows;
  }

  if (!opts.isUnified && opts.selected) {
    const { data } = await appApi.mailMessages.list({
      accountId: opts.selected.id,
      label,
      search,
      limit,
    });
    return data as EmailListItem[];
  }

  // Unified: current workspace (if the JWT has an org) + personal.
  const [workspace, personal] = await Promise.allSettled([
    appApi.mailMessages.list({ label, search, limit }),
    personalAccountIds.size > 0
      ? personalApi.mailMessages.list({ label, limit })
      : Promise.resolve({ data: [] as PersonalMailMessage[] }),
  ]);

  const wsRows: EmailListItem[] =
    workspace.status === 'fulfilled' ? (workspace.value.data as EmailListItem[]) : [];
  let personalRows: EmailListItem[] =
    personal.status === 'fulfilled' ? personal.value.data.map(normalizePersonalMessage) : [];
  if (search) personalRows = filterSearch(personalRows, search);

  return mergeByDate(wsRows, personalRows).slice(0, limit);
}

function filterSearch(rows: EmailListItem[], query: string): EmailListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((m) => {
    const from = `${m.from?.name ?? ''} ${m.from?.email ?? ''}`.toLowerCase();
    return (
      (m.subject ?? '').toLowerCase().includes(q) ||
      (m.preview ?? '').toLowerCase().includes(q) ||
      from.includes(q)
    );
  });
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

  const [workspace, personal] = await Promise.allSettled([
    appApi.mailDrafts.list(opts.accountId ? { accountId: opts.accountId } : {}),
    personalAccountIds.size > 0
      ? personalApi.mailDrafts.list(
          opts.accountId && isPersonalAccountId(opts.accountId) ? { accountId: opts.accountId } : {},
        )
      : Promise.resolve({ data: [] }),
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
