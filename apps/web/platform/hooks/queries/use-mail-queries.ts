/**
 * Mail query + mutation hooks.
 *
 * Backed by the unified app-api (`apps/workers/app-api`). Every hook resolves
 * to a typed domain client from `@weldsuite/app-api-client` via
 * `useAppApi()`.
 *
 * Hook signatures are kept stable so existing components don't have to
 * change as the underlying URLs shift; the wire shape returned to
 * components is the app-api `{ data, pagination? }` envelope.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { appSettingsKeys } from '@/hooks/queries/use-app-settings-queries';
import type {
  AssignMailAccountUsersInput,
  CreateMailAccountInput,
  UpdateMailAccountInput,
  SendMailMessageInput,
  UpdateMailMessageInput,
  BulkMailMessageActionInput,
  CreateMailLabelInput,
  UpdateMailLabelInput,
  CreateMailDraftInput,
  UpdateMailDraftInput,
  CreateMailRuleInput,
  UpdateMailRuleInput,
  ReorderMailRulesInput,
  CreateMailTemplateInput,
  UpdateMailTemplateInput,
  RenderMailTemplateInput,
  CreateMailDomainInput,
  CheckWeldMailAddressInput,
  ReserveWeldMailAddressInput,
  SnoozeMessageInput,
  ScheduleMailInput,
  RescheduleMailInput,
  ReplyMailMessageInput,
  ListMailMessagesQuery,
} from '@weldsuite/app-api-client';

// =============================================================================
// Query keys
// =============================================================================

export const mailKeys = {
  all: ['mail'] as const,
  accounts: () => [...mailKeys.all, 'accounts'] as const,
  accountList: (filters?: Record<string, unknown>) =>
    [...mailKeys.all, 'accounts', 'list', filters] as const,
  account: (id: string) => [...mailKeys.all, 'accounts', id] as const,
  accountStats: () => [...mailKeys.all, 'accounts', 'stats'] as const,
  accountLabels: (id: string) => [...mailKeys.all, 'accounts', id, 'labels'] as const,
  messages: (filters?: Record<string, unknown>) => [...mailKeys.all, 'messages', filters] as const,
  message: (id: string) => [...mailKeys.all, 'messages', id] as const,
  messageStats: (accountId?: string) => [...mailKeys.all, 'messages', 'stats', accountId] as const,
  thread: (messageId: string) => [...mailKeys.all, 'thread', messageId] as const,
  threadsByLabel: (params: Record<string, unknown>) =>
    [...mailKeys.all, 'threads-by-label', params] as const,
  labels: (accountId?: string) => [...mailKeys.all, 'labels', accountId] as const,
  label: (id: string) => [...mailKeys.all, 'labels', 'detail', id] as const,
  drafts: (accountId?: string) => [...mailKeys.all, 'drafts', accountId] as const,
  draft: (id: string) => [...mailKeys.all, 'drafts', 'detail', id] as const,
  rules: (accountId?: string) => [...mailKeys.all, 'rules', accountId] as const,
  rule: (id: string) => [...mailKeys.all, 'rules', 'detail', id] as const,
  templates: (filters?: Record<string, unknown>) =>
    [...mailKeys.all, 'templates', filters] as const,
  template: (id: string) => [...mailKeys.all, 'templates', 'detail', id] as const,
  templateCategories: () => [...mailKeys.all, 'templates', 'categories'] as const,
  signatures: () => [...mailKeys.all, 'signatures'] as const,
  signature: (id: string) => [...mailKeys.all, 'signatures', 'detail', id] as const,
  campaigns: () => [...mailKeys.all, 'campaigns'] as const,
  campaign: (id: string) => [...mailKeys.all, 'campaigns', 'detail', id] as const,
  attachments: (messageId: string) => [...mailKeys.all, 'attachments', messageId] as const,
  attachment: (id: string) => [...mailKeys.all, 'attachments', 'detail', id] as const,
  domains: () => [...mailKeys.all, 'domains'] as const,
  domain: (id: string) => [...mailKeys.all, 'domains', id] as const,
  weldmail: () => [...mailKeys.all, 'weldmail'] as const,
  weldmailDomain: () => [...mailKeys.all, 'weldmail', 'domain'] as const,
  weldmailAddresses: () => [...mailKeys.all, 'weldmail', 'addresses'] as const,
  syncStatus: (accountId: string) => [...mailKeys.all, 'sync', accountId] as const,
  scheduledEmails: (accountId?: string) => [...mailKeys.all, 'scheduled', accountId] as const,
  snoozedEmails: (accountId?: string) => [...mailKeys.all, 'snoozed', accountId] as const,
  search: (query: string) => [...mailKeys.all, 'search', query] as const,
  contacts: (query?: string) => [...mailKeys.all, 'contacts', query] as const,
  recentContacts: () => [...mailKeys.all, 'contacts', 'recent'] as const,
  settings: () => [...mailKeys.all, 'settings'] as const,
};

// =============================================================================
// Shared types — kept for components that still import from this module.
// =============================================================================

interface ContactSuggestion {
  id: string;
  email: string;
  name: string;
  company: string | null;
  avatarUrl: string | null;
  color: string;
}

// =============================================================================
// Accounts
// =============================================================================

export function useMailAccounts() {
  const { mailAccounts } = useAppApi();
  return useQuery({
    queryKey: mailKeys.accounts(),
    queryFn: () => mailAccounts.list(),
  });
}

function useMailAccount(id: string, enabled = true) {
  const { mailAccounts } = useAppApi();
  return useQuery({
    queryKey: mailKeys.account(id),
    queryFn: () => mailAccounts.get(id),
    enabled: !!id && enabled,
  });
}

function useMailAccountStats() {
  const { mailAccounts } = useAppApi();
  return useQuery({
    queryKey: mailKeys.accountStats(),
    queryFn: () => mailAccounts.stats(),
  });
}

function useMailAccountLabels(id: string, enabled = true) {
  const { mailAccounts } = useAppApi();
  return useQuery({
    queryKey: mailKeys.accountLabels(id),
    queryFn: () => mailAccounts.listLabels(id),
    enabled: !!id && enabled,
  });
}

export function useCreateMailAccount() {
  const { mailAccounts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailAccountInput) => mailAccounts.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.accounts() });
      // The WeldMail settings page reads accounts from the combined
      // app-settings query, not mailKeys — invalidate it too.
      qc.invalidateQueries({ queryKey: appSettingsKeys.mail() });
    },
  });
}

export function useUpdateMailAccount() {
  const { mailAccounts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    // Flat call shape — `{ id, ...fields }` — matches the legacy hook so
    // callers don't have to wrap fields under `data`.
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailAccountInput) =>
      mailAccounts.update(id, fields),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: mailKeys.account(id) });
      qc.invalidateQueries({ queryKey: mailKeys.accounts() });
      qc.invalidateQueries({ queryKey: appSettingsKeys.mail() });
    },
  });
}

export function useDeleteMailAccount() {
  const { mailAccounts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailAccounts.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.accounts() });
      qc.invalidateQueries({ queryKey: appSettingsKeys.mail() });
    },
  });
}

function useSyncMailAccount() {
  const { mailAccounts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailAccounts.triggerSync(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: mailKeys.account(id) });
      qc.invalidateQueries({ queryKey: mailKeys.syncStatus(id) });
    },
  });
}

export function useAssignMailAccountUsers() {
  const { mailAccounts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & AssignMailAccountUsersInput) =>
      mailAccounts.assignUsers(id, fields),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: mailKeys.account(id) });
      qc.invalidateQueries({ queryKey: mailKeys.accounts() });
      qc.invalidateQueries({ queryKey: appSettingsKeys.mail() });
    },
  });
}

// =============================================================================
// Messages
// =============================================================================

/** Map legacy `{ accountId, pageSize?, page? }` to app-api `{ accountId, limit?, cursor? }`. */
function toMessageQuery(
  accountId: string | undefined,
  params: Record<string, unknown> | undefined,
): Partial<ListMailMessagesQuery> {
  const out: Record<string, unknown> = { ...(params ?? {}) };
  if (accountId) out.accountId = accountId;
  if (out.pageSize !== undefined) {
    out.limit = out.pageSize;
    delete out.pageSize;
  }
  delete out.page;
  return out as Partial<ListMailMessagesQuery>;
}

export function useMailMessages(
  accountId: string,
  params?: Record<string, unknown>,
  enabled = true,
) {
  const { mailMessages } = useAppApi();
  const filters = toMessageQuery(accountId, params);
  return useQuery({
    queryKey: mailKeys.messages(filters as Record<string, unknown>),
    queryFn: () => mailMessages.list(filters),
    enabled: !!accountId && enabled,
  });
}

/**
 * Cross-account list — backs the CRM company-panel Emails tab. We pass
 * the counterparty email through as a search term since the app-api
 * list endpoint already greps subject + preview; a tighter
 * `from/to/cc/bcc` filter is a follow-up if needed.
 */
export function useMailMessagesByCounterparty(
  counterpartyEmail: string | null | undefined,
  enabled = true,
) {
  const { mailMessages } = useAppApi();
  return useQuery({
    queryKey: mailKeys.messages({ counterpartyEmail }),
    queryFn: () => mailMessages.list({ search: counterpartyEmail ?? undefined, limit: 100 }),
    enabled: !!counterpartyEmail && enabled,
  });
}

export function useMailMessage(id: string, enabled = true) {
  const { mailMessages } = useAppApi();
  return useQuery({
    queryKey: mailKeys.message(id),
    queryFn: () => mailMessages.get(id),
    enabled: !!id && enabled,
  });
}

export function useMailMessageStats(accountId?: string, enabled = true) {
  const { mailMessages } = useAppApi();
  return useQuery({
    queryKey: mailKeys.messageStats(accountId),
    queryFn: () => mailMessages.stats(accountId),
    enabled,
  });
}

export function useMailThread(_accountId: string, messageId: string, enabled = true) {
  const { mailMessages } = useAppApi();
  return useQuery({
    queryKey: mailKeys.thread(messageId),
    queryFn: () => mailMessages.thread(messageId),
    enabled: !!messageId && enabled,
  });
}

function useSendMail() {
  const { mailAccounts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, data }: { accountId: string; data: SendMailMessageInput }) =>
      mailAccounts.send(accountId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useReplyToMail() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, data }: { messageId: string; data: ReplyMailMessageInput }) =>
      mailMessages.reply(messageId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useForwardMail() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      data,
    }: {
      messageId: string;
      data: { to: string[]; body?: string; htmlBody?: string };
    }) => mailMessages.forward(messageId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useDeleteMailMessage() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailMessages.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useUpdateMailMessage() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailMessageInput) =>
      mailMessages.update(id, fields),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: mailKeys.message(id) });
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useMarkMailRead() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isRead }: { id: string; isRead: boolean }) =>
      mailMessages.update(id, { isRead }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useToggleMailStar() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isStarred }: { id: string; isStarred: boolean }) =>
      mailMessages.update(id, { isStarred }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useMoveToTrash() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailMessages.bulk({ messageIds: [id], action: 'trash' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useArchiveMailMessage() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      mailMessages.update(id, {
        labels: ['ARCHIVE'],
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useMarkAsSpam() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailMessages.update(id, { isSpam: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useUpdateMessageLabels() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      action,
      labels,
    }: {
      messageId: string;
      action: 'add' | 'remove';
      labels: string[];
    }) =>
      action === 'add'
        ? mailMessages.addLabels(messageId, { labels })
        : mailMessages.removeLabels(messageId, { labels }),
    onSuccess: (_res, { messageId }) => {
      qc.invalidateQueries({ queryKey: mailKeys.message(messageId) });
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useBulkMailAction() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: BulkMailMessageActionInput) => mailMessages.bulk(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

// =============================================================================
// Threads
// =============================================================================

export function useMarkThreadAsRead() {
  const { mailThreads } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      accountId,
      threadId,
      isRead,
    }: {
      accountId: string;
      threadId: string;
      isRead: boolean;
    }) => mailThreads.markRead(threadId, accountId, { isRead }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

/**
 * Thread-level "archive / trash / mark-spam / update labels" don't have
 * dedicated app-api endpoints today; they're expressed as a
 * `applyLabelToThread` add/remove or as a bulk message action over the
 * thread's member ids. Components that need the bulk flavour should use
 * `useApplyLabelToThread` plus `useMarkThreadAsRead` directly.
 */
function useApplyLabelToThread() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      accountId,
      threadId,
      labelName,
      action,
    }: {
      accountId: string;
      threadId: string;
      labelName: string;
      action: 'add' | 'remove';
    }) => mailLabels.applyToThread({ accountId, threadId, labelName, action }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

/**
 * Sugar over `mailLabels.applyToThread` so the message-detail UI can
 * keep calling `mutation.mutate({accountId, threadId}, {onSuccess, ...})`
 * without re-deriving the label name on each call. We define each via
 * its own `useMutation` so React Query's full options-bag signature is
 * preserved (a wrapped `mutate` would shadow it with a 1-arg form).
 *
 * The legacy hooks returned counts named after the action
 * (`trashedCount`, `archivedCount`) — preserve them so existing toasts
 * keep their numbers.
 */
export function useArchiveThread() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { accountId: string; threadId: string }) => {
      const result = await mailLabels.applyToThread({
        ...vars,
        labelName: 'ARCHIVE',
        action: 'add',
      });
      return { ...result, archivedCount: result.data?.affected ?? 0 };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useTrashThread() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { accountId: string; threadId: string }) => {
      const result = await mailLabels.applyToThread({
        ...vars,
        labelName: 'TRASH',
        action: 'add',
      });
      return { ...result, trashedCount: result.data?.affected ?? 0 };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

/**
 * Toggling spam needs both directions — adding the label on first call
 * and removing it on the second. The component passes the desired
 * end state via `isSpam`.
 */
export function useMarkThreadAsSpam() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { accountId: string; threadId: string; isSpam?: boolean }) => {
      const action: 'add' | 'remove' = vars.isSpam === false ? 'remove' : 'add';
      return mailLabels.applyToThread({
        accountId: vars.accountId,
        threadId: vars.threadId,
        labelName: 'SPAM',
        action,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useUpdateThreadLabels() {
  return useApplyLabelToThread();
}

// =============================================================================
// Labels
// =============================================================================

export function useMailLabels(accountId?: string, enabled = true) {
  const { mailLabels } = useAppApi();
  return useQuery({
    queryKey: mailKeys.labels(accountId),
    queryFn: () => mailLabels.list({ accountId }),
    enabled,
  });
}

function useMailLabel(id: string, enabled = true) {
  const { mailLabels } = useAppApi();
  return useQuery({
    queryKey: mailKeys.label(id),
    queryFn: () => mailLabels.get(id),
    enabled: !!id && enabled,
  });
}

export function useCreateMailLabel() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailLabelInput) => mailLabels.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.labels() });
    },
  });
}

export function useUpdateMailLabel() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailLabelInput) =>
      mailLabels.update(id, fields),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: mailKeys.label(id) });
      qc.invalidateQueries({ queryKey: mailKeys.labels() });
    },
  });
}

export function useDeleteMailLabel() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailLabels.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.labels() });
    },
  });
}

export function useMailLabelThreads(
  params: { accountId?: string; labelSlug: string; page?: number; pageSize?: number },
  enabled = true,
) {
  const { mailLabels } = useAppApi();
  return useQuery({
    queryKey: mailKeys.threadsByLabel(params),
    queryFn: () =>
      mailLabels.threads({
        accountId: params.accountId,
        labelSlug: params.labelSlug,
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 25,
      }),
    enabled: !!params.labelSlug && enabled,
  });
}

// =============================================================================
// Drafts
// =============================================================================

export function useMailDrafts(accountId?: string, enabled = true) {
  const { mailDrafts } = useAppApi();
  return useQuery({
    queryKey: mailKeys.drafts(accountId),
    queryFn: () => mailDrafts.list({ accountId }),
    enabled,
  });
}

function useMailDraft(id: string, enabled = true) {
  const { mailDrafts } = useAppApi();
  return useQuery({
    queryKey: mailKeys.draft(id),
    queryFn: () => mailDrafts.get(id),
    enabled: !!id && enabled,
  });
}

export function useCreateMailDraft() {
  const { mailDrafts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailDraftInput) => mailDrafts.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.drafts() });
    },
  });
}

function useUpdateMailDraft() {
  const { mailDrafts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailDraftInput) =>
      mailDrafts.update(id, fields),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: mailKeys.draft(id) });
      qc.invalidateQueries({ queryKey: mailKeys.drafts() });
    },
  });
}

export function useDeleteMailDraft() {
  const { mailDrafts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailDrafts.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.drafts() });
    },
  });
}

/**
 * "Send a draft" = read draft → POST mail-accounts/:id/send → delete
 * draft. Composed in the hook so the UI doesn't have to orchestrate.
 */
function useSendMailDraft() {
  const { mailDrafts, mailAccounts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const draft = await mailDrafts.get(id);
      const row = draft.data;
      const payload: SendMailMessageInput = {
        to: (row.to ?? []) as string[],
        cc: (row.cc ?? undefined) as string[] | undefined,
        bcc: (row.bcc ?? undefined) as string[] | undefined,
        subject: row.subject ?? undefined,
        body: row.body ?? undefined,
        htmlBody: row.htmlBody ?? undefined,
      };
      const result = await mailAccounts.send(row.accountId, payload);
      await mailDrafts.delete(id);
      return result;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.drafts() });
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

// =============================================================================
// Rules
// =============================================================================

function useMailRules(accountId: string, enabled = true) {
  const { mailRules } = useAppApi();
  return useQuery({
    queryKey: mailKeys.rules(accountId),
    queryFn: () => mailRules.list({ accountId }),
    enabled: !!accountId && enabled,
  });
}

function useMailRule(id: string, enabled = true) {
  const { mailRules } = useAppApi();
  return useQuery({
    queryKey: mailKeys.rule(id),
    queryFn: () => mailRules.get(id),
    enabled: !!id && enabled,
  });
}

function useCreateMailRule() {
  const { mailRules } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailRuleInput) => mailRules.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.rules() });
    },
  });
}

function useUpdateMailRule() {
  const { mailRules } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailRuleInput) =>
      mailRules.update(id, fields),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: mailKeys.rule(id) });
      qc.invalidateQueries({ queryKey: mailKeys.rules() });
    },
  });
}

function useDeleteMailRule() {
  const { mailRules } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailRules.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.rules() });
    },
  });
}

function useToggleMailRule() {
  const { mailRules } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailRules.toggle(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: mailKeys.rule(id) });
      qc.invalidateQueries({ queryKey: mailKeys.rules() });
    },
  });
}

function useDuplicateMailRule() {
  const { mailRules } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailRules.duplicate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.rules() });
    },
  });
}

function useReorderMailRules() {
  const { mailRules } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ReorderMailRulesInput) => mailRules.reorder(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.rules() });
    },
  });
}

// =============================================================================
// Templates
// =============================================================================

function useMailTemplates(options?: {
  category?: string;
  type?: string;
  isActive?: boolean;
}) {
  const { mailTemplates } = useAppApi();
  return useQuery({
    queryKey: mailKeys.templates(options as Record<string, unknown>),
    queryFn: () =>
      mailTemplates.list({
        category: options?.category,
        type: options?.type as never,
        isActive: options?.isActive,
      }),
  });
}

function useMailTemplate(id: string, enabled = true) {
  const { mailTemplates } = useAppApi();
  return useQuery({
    queryKey: mailKeys.template(id),
    queryFn: () => mailTemplates.get(id),
    enabled: !!id && enabled,
  });
}

function useMailTemplateCategories() {
  const { mailTemplates } = useAppApi();
  return useQuery({
    queryKey: mailKeys.templateCategories(),
    queryFn: () => mailTemplates.categories(),
  });
}

function useCreateMailTemplate() {
  const { mailTemplates } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailTemplateInput) => mailTemplates.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.templates() });
    },
  });
}

function useUpdateMailTemplate() {
  const { mailTemplates } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailTemplateInput) =>
      mailTemplates.update(id, fields),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: mailKeys.template(id) });
      qc.invalidateQueries({ queryKey: mailKeys.templates() });
    },
  });
}

function useDeleteMailTemplate() {
  const { mailTemplates } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailTemplates.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.templates() });
    },
  });
}

function useDuplicateMailTemplate() {
  const { mailTemplates } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailTemplates.duplicate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.templates() });
    },
  });
}

function useRenderMailTemplate() {
  const { mailTemplates } = useAppApi();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: RenderMailTemplateInput }) =>
      mailTemplates.render(id, data),
  });
}

// =============================================================================
// Attachments
// =============================================================================

export function useMailAttachments(messageId: string, enabled = true) {
  const { mailAttachments } = useAppApi();
  return useQuery({
    queryKey: mailKeys.attachments(messageId),
    queryFn: () => mailAttachments.listForMessage(messageId),
    enabled: !!messageId && enabled,
  });
}

function useConfirmAttachmentUpload() {
  const { mailAttachments } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { messageId: string; attachmentIds: string[] }) =>
      mailAttachments.associate(data),
    onSuccess: (_res, { messageId }) => {
      qc.invalidateQueries({ queryKey: mailKeys.attachments(messageId) });
    },
  });
}

function useDeleteMailAttachment() {
  const { mailAttachments } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailAttachments.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

// =============================================================================
// Domains
// =============================================================================

export function useMailDomains() {
  const { mailDomains } = useAppApi();
  return useQuery({
    queryKey: mailKeys.domains(),
    queryFn: () => mailDomains.list(),
  });
}

function useMailDomain(id: string, enabled = true) {
  const { mailDomains } = useAppApi();
  return useQuery({
    queryKey: mailKeys.domain(id),
    queryFn: () => mailDomains.get(id),
    enabled: !!id && enabled,
  });
}

function useAddMailDomain() {
  const { mailDomains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailDomainInput) => mailDomains.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.domains() });
    },
  });
}

function useDeleteMailDomain() {
  const { mailDomains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailDomains.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.domains() });
    },
  });
}

function useVerifyMailDomainDns() {
  const { mailDomains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailDomains.verify(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: mailKeys.domain(id) });
      qc.invalidateQueries({ queryKey: mailKeys.domains() });
    },
  });
}

function useSyncDomainWithProvider() {
  const { mailDomains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailDomains.sync(id),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: mailKeys.domain(id) });
      qc.invalidateQueries({ queryKey: mailKeys.domains() });
    },
  });
}

// =============================================================================
// WeldMail (shared {slug}.weldmail.com addresses)
// =============================================================================

export function useWeldMailDomain() {
  const { mailWeldMail } = useAppApi();
  return useQuery({
    queryKey: mailKeys.weldmailDomain(),
    queryFn: () => mailWeldMail.domain(),
  });
}

function useWeldMailAddresses() {
  const { mailWeldMail } = useAppApi();
  return useQuery({
    queryKey: mailKeys.weldmailAddresses(),
    queryFn: () => mailWeldMail.list(),
  });
}

export function useCheckWeldMailAvailability() {
  const { mailWeldMail } = useAppApi();
  return useMutation({
    mutationFn: (data: CheckWeldMailAddressInput) => mailWeldMail.check(data),
  });
}

export function useReserveWeldMailAddress() {
  const { mailWeldMail } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ReserveWeldMailAddressInput) => mailWeldMail.reserve(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.weldmail() });
      qc.invalidateQueries({ queryKey: mailKeys.accounts() });
      qc.invalidateQueries({ queryKey: appSettingsKeys.mail() });
    },
  });
}

function useDeleteWeldMailAddress() {
  const { mailWeldMail } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailWeldMail.release(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.weldmail() });
      qc.invalidateQueries({ queryKey: mailKeys.accounts() });
      qc.invalidateQueries({ queryKey: appSettingsKeys.mail() });
    },
  });
}

// =============================================================================
// Sync
// =============================================================================

function useMailSyncStatus(accountId: string, enabled = true) {
  const { mailSync } = useAppApi();
  return useQuery({
    queryKey: mailKeys.syncStatus(accountId),
    queryFn: () => mailSync.getSyncStatus(accountId),
    enabled: !!accountId && enabled,
  });
}

/**
 * "Sync folders" isn't on the mail-sync route — folder sync flows
 * through `mail-folders` once that has provider-side hooks. For now it
 * proxies to full-sync since both flip `syncStatus` and trigger the
 * out-of-band fetch loop.
 */
function useSyncMailFolders() {
  const { mailSync } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => mailSync.fullSync(accountId),
    onSuccess: (_res, accountId) => {
      qc.invalidateQueries({ queryKey: mailKeys.syncStatus(accountId) });
    },
  });
}

function useSyncMailMessages() {
  const { mailSync } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, label }: { accountId: string; label?: string }) =>
      mailSync.syncMessages(accountId, label !== undefined ? { label } : {}),
    onSuccess: (_res, { accountId }) => {
      qc.invalidateQueries({ queryKey: mailKeys.syncStatus(accountId) });
      qc.invalidateQueries({ queryKey: mailKeys.messages() });
    },
  });
}

function useFullMailSync() {
  const { mailSync } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => mailSync.fullSync(accountId),
    onSuccess: (_res, accountId) => {
      qc.invalidateQueries({ queryKey: mailKeys.syncStatus(accountId) });
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

// =============================================================================
// Snooze
// =============================================================================

export function useSnoozeEmail() {
  const { mailSnooze } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      accountId,
      messageId,
      data,
    }: {
      accountId: string;
      messageId: string;
      data: SnoozeMessageInput;
    }) => mailSnooze.snooze(accountId, messageId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useUnsnoozeEmail() {
  const { mailSnooze } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, messageId }: { accountId: string; messageId: string }) =>
      mailSnooze.unsnooze(accountId, messageId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useSnoozedEmails(accountId?: string, enabled = true) {
  const { mailSnooze } = useAppApi();
  return useQuery({
    queryKey: mailKeys.snoozedEmails(accountId),
    queryFn: () => mailSnooze.listSnoozed({ accountId }),
    enabled,
  });
}

// =============================================================================
// Scheduled
// =============================================================================

function useScheduleEmail() {
  const { mailScheduled } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ScheduleMailInput) => mailScheduled.schedule(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.scheduledEmails() });
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useCancelScheduledEmail() {
  const { mailScheduled } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => mailScheduled.cancel(messageId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.scheduledEmails() });
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

function useRescheduleEmail() {
  const { mailScheduled } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, data }: { messageId: string; data: RescheduleMailInput }) =>
      mailScheduled.reschedule(messageId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.scheduledEmails() });
    },
  });
}

function useSendScheduledNow() {
  const { mailScheduled } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => mailScheduled.sendNow(messageId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.scheduledEmails() });
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useScheduledEmails(accountId?: string, enabled = true) {
  const { mailScheduled } = useAppApi();
  return useQuery({
    queryKey: mailKeys.scheduledEmails(accountId),
    queryFn: () => mailScheduled.list({ accountId }),
    enabled,
  });
}

// =============================================================================
// AI — `app-api/mail-ai` proxies to agent-worker `/dispatch/mail-ai/*`,
// which returns the legacy `{ success, data }` envelope shape the
// platform consumers already destructure. The `mailAi.*` client returns
// the raw `Response` (so streaming endpoints would work), so we
// `.json()` here to match consumer expectations.
// =============================================================================

interface AiDraftResponse {
  success: boolean;
  data?: { subject?: string; body?: string };
  /** auto-draft returns the draft under `draft`; compose draft uses `data`. */
  draft?: { subject?: string; body?: string };
}

interface AiReplyResponse {
  success: boolean;
  /** reply returns the body at the top level; `data.body` mirrors it. */
  body?: string;
  data?: { body?: string };
}

export function useGenerateEmailDraft() {
  const { mailAi } = useAppApi();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>): Promise<AiDraftResponse> => {
      const res = await mailAi.draft(data as Parameters<typeof mailAi.draft>[0]);
      return res.json();
    },
  });
}

export function useGenerateAutoDraft() {
  const { mailAi } = useAppApi();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>): Promise<AiDraftResponse> => {
      const res = await mailAi.autoDraft(data as Parameters<typeof mailAi.autoDraft>[0]);
      return res.json();
    },
  });
}

export function useGenerateAIReply() {
  const { mailAi } = useAppApi();
  return useMutation({
    mutationFn: async (data: Record<string, unknown>): Promise<AiReplyResponse> => {
      const res = await mailAi.reply(data as Parameters<typeof mailAi.reply>[0]);
      // The endpoint returns `body` at the top level (compose panel +
      // message-detail read `result.body`); `data.body` mirrors it. Lift
      // from either shape so all consumers work.
      const json = (await res.json()) as {
        success: boolean;
        body?: string;
        data?: { body?: string };
      };
      return { success: json.success, body: json.body ?? json.data?.body, data: json.data };
    },
  });
}

interface AiInboxSummaryResponse {
  success: boolean;
  data?: { summary?: string };
}

interface AiSmartRepliesResponse {
  success: boolean;
  data?: { replies?: string[] };
}

/**
 * Generate an AI inbox summary for a given account.
 * Calls `POST /api/mail-ai/inbox-summary` → agent-worker → summary text.
 */
export function useInboxSummary() {
  const { mailAi } = useAppApi();
  return useMutation({
    mutationFn: async (data: Parameters<typeof mailAi.inboxSummary>[0]): Promise<AiInboxSummaryResponse> => {
      const res = await mailAi.inboxSummary(data);
      return res.json();
    },
  });
}

/**
 * Generate smart reply suggestions for a given message.
 * Calls `POST /api/mail-ai/smart-replies` → agent-worker → reply candidates.
 */
export function useSmartReplies() {
  const { mailAi } = useAppApi();
  return useMutation({
    mutationFn: async (data: Parameters<typeof mailAi.smartReplies>[0]): Promise<AiSmartRepliesResponse> => {
      const res = await mailAi.smartReplies(data);
      return res.json();
    },
  });
}

// =============================================================================
// Search — legacy until a dedicated search endpoint lands on app-api.
// =============================================================================

function useSearchMail(query: string, enabled = true) {
  const { mailMessages } = useAppApi();
  return useQuery({
    queryKey: mailKeys.search(query),
    queryFn: () => mailMessages.list({ search: query, limit: 50 }),
    enabled: !!query && query.length >= 2 && enabled,
  });
}

function useSearchMailMutation() {
  const { mailMessages } = useAppApi();
  return useMutation({
    mutationFn: (query: string) => mailMessages.list({ search: query, limit: 50 }),
  });
}

