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

import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import { appSettingsKeys } from '@/hooks/queries/use-app-settings-queries';
import { mailKeys } from '@/hooks/queries/mail-keys';
import { patchCachedImportant } from '@/app/weldmail/lib/important-cache';
import { refreshSidebarBadges } from '@/hooks/use-sidebar-badges';
import { mailLabelThreadsInfiniteQueryOptions } from '@/app/weldmail/lib/mail-label-threads-query';
import type {
  AssignMailAccountUsersInput,
  CreateMailAccountInput,
  UpdateMailAccountInput,
  BulkMailMessageActionInput,
  CreateMailLabelInput,
  UpdateMailLabelInput,
  CreateMailSignatureInput,
  UpdateMailSignatureInput,
  CreateMailDraftInput,
  CheckWeldMailAddressInput,
  ReserveWeldMailAddressInput,
  SnoozeMessageInput,
  ListMailMessagesQuery,
} from '@weldsuite/app-api-client';

// =============================================================================
// Query keys
// =============================================================================

// Defined in `./mail-keys` (no dependencies of its own) and re-exported here
// so every existing `import { mailKeys } from '@/hooks/queries/use-mail-queries'`
// call site keeps working unchanged.
export { mailKeys };

// =============================================================================
// Accounts
// =============================================================================

export function useMailAccounts(enabled = true) {
  const { mailAccounts } = useAppApi();
  return useQuery({
    queryKey: mailKeys.accounts(),
    queryFn: () => mailAccounts.list(),
    enabled,
  });
}export function useCreateMailAccount() {
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
  const out: Record<string, unknown> = { ...params };
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
    // Rows carry full bodies (`textBody`/`htmlBody`) — don't let them into the
    // persisted cache (docs/plans/weldmail-mailbox-storage.md phase 1 item 6).
    meta: { persist: false },
  });
}

/**
 * Cross-account list — backs the CRM company-panel Emails tab. Filters by
 * `counterparty`, an exact address match served by the mailbox store's
 * address index in object mode (mailbox-store design §5), instead of the
 * `search` free-text term — same result set (the sender/recipient is still
 * matched exactly), but it no longer fans the query out across every
 * accessible mailbox when the store can narrow it up front.
 */
export function useMailMessagesByCounterparty(
  counterpartyEmail: string | null | undefined,
  enabled = true,
) {
  const { mailMessages } = useAppApi();
  return useQuery({
    queryKey: mailKeys.messages({ counterpartyEmail }),
    queryFn: () => mailMessages.list({ counterparty: counterpartyEmail ?? undefined, limit: 100 }),
    enabled: !!counterpartyEmail && enabled,
    meta: { persist: false },
  });
}

export function useMailMessage(id: string, enabled = true) {
  const { mailMessages } = useAppApi();
  return useQuery({
    queryKey: mailKeys.message(id),
    queryFn: () => mailMessages.get(id),
    enabled: !!id && enabled,
    // Full message body — don't persist (phase 1 item 6).
    meta: { persist: false },
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
    // Full thread, bodies included — don't persist (phase 1 item 6).
    meta: { persist: false },
  });
}export function useMarkMailRead() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isRead }: { id: string; isRead: boolean }) =>
      mailMessages.update(id, { isRead }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
      // The unread count on the WeldMail rail icon.
      refreshSidebarBadges(qc);
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

/**
 * Mark a message important / not important. The cached message, thread and
 * folder rows flip at once; the refetch afterwards (also on failure) puts the
 * server's truth back.
 */
export function useToggleMailImportant() {
  const { mailMessages } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isImportant }: { id: string; isImportant: boolean }) =>
      mailMessages.update(id, { isImportant }),
    onMutate: ({ id, isImportant }) => {
      qc.setQueriesData({ queryKey: mailKeys.all }, (cached: unknown) =>
        patchCachedImportant(cached, id, isImportant),
      );
    },
    onSettled: () => {
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
    // Adding ARCHIVE moves the mail out of the inbox and keeps its other
    // labels (replacing the whole array dropped them).
    mutationFn: (id: string) => mailMessages.addLabels(id, { labels: ['ARCHIVE'] }),
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
      // Read, unread, trash and spam all move the rail's unread count.
      refreshSidebarBadges(qc);
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
      refreshSidebarBadges(qc);
    },
  });
}

/** "Mark all as read" for a folder; no `accountId` for the unified folder. */
export function useMarkFolderAsRead() {
  const { mailThreads } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { labelSlug: string; accountId?: string }) =>
      (await mailThreads.markAllRead(vars)).data,
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
      // ARCHIVE, TRASH, SPAM and INBOX are locations: adding one moves the
      // thread there, the server drops the previous one in the same write.
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
 * Toggling spam needs both directions. The component passes the desired end
 * state via `isSpam`: marking spam moves the thread to Spam, "not spam" moves
 * it back to the inbox (removing the label alone would leave it in no folder).
 */
export function useMarkThreadAsSpam() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { accountId: string; threadId: string; isSpam?: boolean }) => {
      return mailLabels.applyToThread({
        accountId: vars.accountId,
        threadId: vars.threadId,
        labelName: vars.isSpam === false ? 'INBOX' : 'SPAM',
        action: 'add',
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

/** A rule is the block rule for `email` when it sends exactly that From address to Spam. */
function isBlockRuleFor(
  rule: { conditions: { field: string; operator: string; value: string | string[] }[]; actions: { type: string }[] },
  email: string,
): boolean {
  return (
    rule.actions.some((a) => a.type === 'mark_as_spam') &&
    rule.conditions.some(
      (c) => c.field === 'from' && c.operator === 'equals' && typeof c.value === 'string' && c.value.toLowerCase() === email,
    )
  );
}

/**
 * Block a sender: a mail rule sends every future message from the address to
 * Spam (the inbound worker marks it as spam, so no push goes out), and the
 * open thread moves to Spam now. Blocking an already-blocked address adds no
 * second rule.
 */
export function useBlockSender() {
  const { mailRules, mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { accountId: string; email: string; threadId?: string }) => {
      const email = vars.email.trim().toLowerCase();
      const existing = await mailRules.list({ accountId: vars.accountId });
      if (!existing.data.some((rule) => rule.isActive && isBlockRuleFor(rule, email))) {
        await mailRules.create({
          accountId: vars.accountId,
          name: `Block ${email}`,
          conditions: [{ field: 'from', operator: 'equals', value: email }],
          actions: [{ type: 'mark_as_spam' }],
          stopProcessing: true,
          scope: 'incoming',
        });
      }
      if (vars.threadId) {
        await mailLabels.applyToThread({
          accountId: vars.accountId,
          threadId: vars.threadId,
          labelName: 'SPAM',
          action: 'add',
        });
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useUpdateThreadLabels() {
  return useApplyLabelToThread();
}

/** Move a thread back to the inbox (out of trash, spam or the archive). */
export function useMoveThreadToInbox() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { accountId: string; threadId: string }) =>
      mailLabels.applyToThread({ ...vars, labelName: 'INBOX', action: 'add' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

/**
 * Star / pin a whole thread. Both are system labels on the thread's messages
 * (`STARRED`, `PINNED`), so they persist, show in every list and survive a
 * reload.
 */
function useToggleThreadSystemLabel(labelName: 'STARRED' | 'PINNED') {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { accountId: string; threadId: string; on: boolean }) =>
      mailLabels.applyToThread({
        accountId: vars.accountId,
        threadId: vars.threadId,
        labelName,
        action: vars.on ? 'add' : 'remove',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.all });
    },
  });
}

export function useStarThread() {
  return useToggleThreadSystemLabel('STARRED');
}

export function usePinThread() {
  return useToggleThreadSystemLabel('PINNED');
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
export function useCreateMailLabel() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailLabelInput) => mailLabels.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.labelsAll() });
    },
  });
}

export function useUpdateMailLabel() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailLabelInput) =>
      mailLabels.update(id, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.labelsAll() });
    },
  });
}

export function useDeleteMailLabel() {
  const { mailLabels } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailLabels.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.labelsAll() });
    },
  });
}

// =============================================================================
// Signatures
// =============================================================================

/**
 * The caller's signatures: their own personal ones plus the shared ones. Few
 * enough to load in one page, and the composer reads them on every open, so
 * they stay fresh for a while.
 */
export function useMailSignatures(enabled = true) {
  const { mailSignatures } = useAppApi();
  return useQuery({
    queryKey: mailKeys.signatures(),
    queryFn: () => mailSignatures.list({ limit: 100 }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCreateMailSignature() {
  const { mailSignatures } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMailSignatureInput) => mailSignatures.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.signatures() });
    },
  });
}

export function useUpdateMailSignature() {
  const { mailSignatures } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...fields }: { id: string } & UpdateMailSignatureInput) =>
      mailSignatures.update(id, fields),
    // Making one the default can unset others, so the whole list is refetched.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.signatures() });
    },
  });
}

export function useDeleteMailSignature() {
  const { mailSignatures } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailSignatures.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.signatures() });
    },
  });
}


/** Server-side narrowing of a thread list: the search box and the Filter panel. */
export type MailThreadSearch = {
  /** Free text; searches the whole mailbox, not only the open folder. */
  search?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** "Doesn't have": threads where any message has any of these words are left out. */
  excludeWords?: string;
  hasAttachment?: boolean;
};

export function useMailLabelThreads(
  params: { accountId?: string; labelSlug: string; page?: number; pageSize?: number } & MailThreadSearch,
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
        search: params.search || undefined,
        from: params.from || undefined,
        to: params.to || undefined,
        subject: params.subject || undefined,
        excludeWords: params.excludeWords || undefined,
        hasAttachment: params.hasAttachment || undefined,
      }),
    enabled: !!params.labelSlug && enabled,
  });
}

/**
 * Infinite-scroll thread list for a label. Pages are appended as the list
 * sentinel intersects the viewport.
 *
 * Built from `mailLabelThreadsInfiniteQueryOptions`, the options factory this
 * hook shares with the label route's `beforeLoad` prefetch
 * (app/weldmail/lib/label-route-prefetch.ts) and the sidebar hover prefetch
 * (hooks/use-app-prefetch.ts) — see that module for why.
 */
export function useInfiniteMailLabelThreads(
  params: { accountId?: string; labelSlug: string; pageSize?: number } & MailThreadSearch,
  enabled = true,
) {
  const { mailLabels } = useAppApi();
  return useInfiniteQuery({
    ...mailLabelThreadsInfiniteQueryOptions(mailLabels.threads, params),
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
export function useDeleteMailDraft() {
  const { mailDrafts } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailDrafts.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.drafts() });
    },
  });
}// =============================================================================
// Attachments
// =============================================================================

export function useMailAttachments(messageId: string, enabled = true) {
  const { mailAttachments } = useAppApi();
  return useQuery({
    queryKey: mailKeys.attachments(messageId),
    queryFn: () => mailAttachments.listForMessage(messageId),
    enabled: !!messageId && enabled,
  });
}// =============================================================================
// Domains
// =============================================================================

export function useMailDomains() {
  const { mailDomains } = useAppApi();
  return useQuery({
    queryKey: mailKeys.domains(),
    queryFn: () => mailDomains.list(),
  });
}

export function useUpdateMailDomain() {
  const { mailDomains } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: import('@weldsuite/app-api-client/schemas/mail-domains').UpdateMailDomainInput;
    }) => mailDomains.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: mailKeys.domains() });
      qc.invalidateQueries({ queryKey: appSettingsKeys.mail() });
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
}// =============================================================================
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

/** Wake snoozed mail early: the given messages go back to the inbox. */
export function useUnsnoozeEmail() {
  const { mailSnooze } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, messageIds }: { accountId: string; messageIds: string[] }) =>
      Promise.all(messageIds.map((messageId) => mailSnooze.unsnooze(accountId, messageId))),
    onSuccess: () => {
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
// Subscriptions (mailing lists + unsubscribe)
// =============================================================================

export function useMailSubscriptions(accountId?: string) {
  const { mailSubscriptions } = useAppApi();
  return useQuery({
    queryKey: mailKeys.subscriptions(accountId),
    queryFn: () => mailSubscriptions.list({ accountId: accountId! }),
    enabled: !!accountId,
  });
}

export function useScanMailSubscriptions() {
  const { mailSubscriptions } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => mailSubscriptions.scan({ accountId }),
    onSuccess: (_res, accountId) => {
      qc.invalidateQueries({ queryKey: mailKeys.subscriptions(accountId) });
    },
  });
}

export function useUnsubscribeMailSubscription() {
  const { mailSubscriptions } = useAppApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mailSubscriptions.unsubscribe(id),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: mailKeys.subscriptions(res.data.subscription.accountId) });
    },
  });
}
