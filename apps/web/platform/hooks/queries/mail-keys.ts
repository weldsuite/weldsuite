/**
 * WeldMail query-key factory.
 *
 * Split out of `use-mail-queries.ts` so it has no dependencies of its own —
 * `app/weldmail/lib/mail-label-threads-query.ts` (the shared infinite-query
 * options factory for the thread list) needs these keys too, and importing
 * them from `use-mail-queries.ts` directly would create a module cycle
 * (that file imports the options factory). `use-mail-queries.ts` re-exports
 * `mailKeys` from here so none of its existing call sites have to change.
 */

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
  // Every label list (each account's, the unified one). `labels()` is not a prefix of
  // `labels('acc')`: its trailing `undefined` only matches an undefined account.
  labelsAll: () => [...mailKeys.all, 'labels'] as const,
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
  subscriptions: (accountId?: string) => [...mailKeys.all, 'subscriptions', accountId] as const,
  search: (query: string) => [...mailKeys.all, 'search', query] as const,
  contacts: (query?: string) => [...mailKeys.all, 'contacts', query] as const,
  recentContacts: () => [...mailKeys.all, 'contacts', 'recent'] as const,
  settings: () => [...mailKeys.all, 'settings'] as const,
};
