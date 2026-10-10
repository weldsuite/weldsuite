/** TanStack Query keys for the partner portal and the managed-workspace queries. */

export const partnerKeys = {
  all: ['partner'] as const,
  memberships: (userId: string | null | undefined) => [...partnerKeys.all, 'me', userId ?? 'anon'] as const,
  scope: (partnerId: string | null) => [...partnerKeys.all, 'p', partnerId ?? 'none'] as const,
  overview: (partnerId: string | null) => [...partnerKeys.scope(partnerId), 'overview'] as const,
  workspaces: (partnerId: string | null) => [...partnerKeys.scope(partnerId), 'workspaces'] as const,
  workspace: (partnerId: string | null, workspaceId: string) =>
    [...partnerKeys.scope(partnerId), 'workspace', workspaceId] as const,
  packages: (partnerId: string | null, archived: boolean) =>
    [...partnerKeys.scope(partnerId), 'packages', archived] as const,
  catalog: (partnerId: string | null) => [...partnerKeys.scope(partnerId), 'catalog'] as const,
  statements: (partnerId: string | null) => [...partnerKeys.scope(partnerId), 'statements'] as const,
  statement: (partnerId: string | null, statementId: string) =>
    [...partnerKeys.scope(partnerId), 'statement', statementId] as const,
  requests: (partnerId: string | null) => [...partnerKeys.scope(partnerId), 'requests'] as const,
  team: (partnerId: string | null) => [...partnerKeys.scope(partnerId), 'team'] as const,
  settings: (partnerId: string | null) => [...partnerKeys.scope(partnerId), 'settings'] as const,
  managedBilling: (orgId: string | null | undefined) => [...partnerKeys.all, 'managed-billing', orgId ?? 'none'] as const,
};
