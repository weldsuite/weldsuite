/**
 * WeldPass hooks — encrypted secret vaults and their deploy targets.
 *
 * Reveals are deliberately NOT cached. A decrypted value is written to the
 * audit trail on every fetch, and holding it in the query cache would both
 * outlive the moment the user asked for it and make the trail lie about how
 * often it was actually read. The reveal hook is a mutation for that reason.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type {
  WeldPassCredential,
  WeldPassProject,
  WeldPassProviderId,
  WeldPassSecret,
  WeldPassSyncTarget,
  WeldPassSyncTargetConfig,
} from '@weldsuite/app-api-client/domains/weldpass';

export const weldpassKeys = {
  all: ['weldpass'] as const,
  projects: () => [...weldpassKeys.all, 'projects'] as const,
  project: (projectId: string) => [...weldpassKeys.all, 'project', projectId] as const,
  secrets: (projectId: string, environmentId: string) =>
    [...weldpassKeys.all, 'secrets', projectId, environmentId] as const,
  versions: (secretId: string) => [...weldpassKeys.all, 'versions', secretId] as const,
  credentials: (projectId: string) => [...weldpassKeys.all, 'credentials', projectId] as const,
  syncTargets: (projectId: string) => [...weldpassKeys.all, 'sync-targets', projectId] as const,
  syncRuns: (projectId: string) => [...weldpassKeys.all, 'sync-runs', projectId] as const,
  audit: (projectId: string) => [...weldpassKeys.all, 'audit', projectId] as const,
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function useWeldPassProjects() {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.projects(),
    queryFn: () => weldpass.listProjects(),
    select: (res) => res.data,
  });
}

export function useWeldPassProject(projectId: string | undefined) {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.project(projectId ?? ''),
    queryFn: () => weldpass.getProject(projectId as string),
    select: (res) => res.data,
    enabled: Boolean(projectId),
  });
}

export function useCreateWeldPassProject() {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<
    { data: WeldPassProject },
    Error,
    { name: string; description?: string | null }
  >({
    mutationFn: (input) => weldpass.createProject(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.projects() });
    },
  });
}

export function useDeleteWeldPassProject() {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (projectId) => weldpass.deleteProject(projectId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.projects() });
    },
  });
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function useWeldPassSecrets(
  projectId: string | undefined,
  environmentId: string | undefined,
) {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.secrets(projectId ?? '', environmentId ?? ''),
    queryFn: () => weldpass.listSecrets(projectId as string, environmentId as string),
    select: (res) => res.data,
    enabled: Boolean(projectId && environmentId),
  });
}

/** Invalidate everything a secret write can affect, including sync state. */
function invalidateAfterSecretWrite(
  qc: ReturnType<typeof useQueryClient>,
  projectId: string,
  environmentId: string,
) {
  qc.invalidateQueries({ queryKey: weldpassKeys.secrets(projectId, environmentId) });
  qc.invalidateQueries({ queryKey: weldpassKeys.project(projectId) });
  qc.invalidateQueries({ queryKey: weldpassKeys.projects() });
  // Auto-sync targets may have pushed as a side effect of the write.
  qc.invalidateQueries({ queryKey: weldpassKeys.syncTargets(projectId) });
  qc.invalidateQueries({ queryKey: weldpassKeys.syncRuns(projectId) });
  qc.invalidateQueries({ queryKey: weldpassKeys.audit(projectId) });
}

export function useCreateWeldPassSecret(projectId: string, environmentId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { key: string; value: string; note?: string | null }) =>
      weldpass.createSecret(projectId, environmentId, input),
    onSuccess: () => invalidateAfterSecretWrite(qc, projectId, environmentId),
  });
}

export function useUpdateWeldPassSecret(projectId: string, environmentId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { secretId: string; value?: string; note?: string | null }) =>
      weldpass.updateSecret(projectId, environmentId, input.secretId, {
        value: input.value,
        note: input.note,
      }),
    onSuccess: () => invalidateAfterSecretWrite(qc, projectId, environmentId),
  });
}

export function useDeleteWeldPassSecret(projectId: string, environmentId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (secretId) => weldpass.deleteSecret(projectId, environmentId, secretId),
    onSuccess: () => invalidateAfterSecretWrite(qc, projectId, environmentId),
  });
}

/**
 * Decrypt one value. A mutation rather than a query so it is never cached,
 * refetched in the background, or replayed on window focus — each reveal is an
 * audited event and should happen exactly when the user asks for it.
 */
export function useRevealWeldPassSecret(projectId: string, environmentId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<WeldPassSecret & { value: string }, Error, string>({
    mutationFn: async (secretId) => {
      const res = await weldpass.revealSecret(projectId, environmentId, secretId);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.audit(projectId) });
    },
  });
}

export function useWeldPassSecretVersions(
  projectId: string,
  environmentId: string,
  secretId: string | undefined,
) {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.versions(secretId ?? ''),
    queryFn: () => weldpass.listVersions(projectId, environmentId, secretId as string),
    select: (res) => res.data,
    enabled: Boolean(secretId),
  });
}

export function useRestoreWeldPassSecret(projectId: string, environmentId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { secretId: string; version: number }) =>
      weldpass.restoreVersion(projectId, environmentId, input.secretId, input.version),
    onSuccess: (_result, input) => {
      invalidateAfterSecretWrite(qc, projectId, environmentId);
      qc.invalidateQueries({ queryKey: weldpassKeys.versions(input.secretId) });
    },
  });
}

export function useImportWeldPassSecrets(projectId: string, environmentId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { content: string; replace?: boolean }) =>
      weldpass.importDotenv(projectId, environmentId, input),
    onSuccess: () => invalidateAfterSecretWrite(qc, projectId, environmentId),
  });
}

/** Requires `secrets:reveal`; the whole environment as `.env` text. */
export function useExportWeldPassEnvironment(projectId: string, environmentId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<Record<string, string>, Error, void>({
    mutationFn: async () => {
      const res = await weldpass.exportEnvironment(projectId, environmentId);
      return res.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.audit(projectId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------

export function useWeldPassCredentials(projectId: string | undefined) {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.credentials(projectId ?? ''),
    queryFn: () => weldpass.listCredentials(projectId as string),
    select: (res) => res.data,
    enabled: Boolean(projectId),
  });
}

export function useCreateWeldPassCredential(projectId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<
    { data: WeldPassCredential },
    Error,
    {
      provider: WeldPassProviderId;
      name: string;
      token: string;
      metadata?: { accountId?: string; teamId?: string };
    }
  >({
    mutationFn: (input) => weldpass.createCredential(projectId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.credentials(projectId) });
    },
  });
}

export function useDeleteWeldPassCredential(projectId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (credentialId) => weldpass.deleteCredential(projectId, credentialId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.credentials(projectId) });
      // Targets using the deleted credential are retired with it.
      qc.invalidateQueries({ queryKey: weldpassKeys.syncTargets(projectId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export function useWeldPassSyncTargets(projectId: string | undefined) {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.syncTargets(projectId ?? ''),
    queryFn: () => weldpass.listSyncTargets(projectId as string),
    select: (res) => res.data,
    enabled: Boolean(projectId),
  });
}

export function useWeldPassSyncRuns(projectId: string | undefined) {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.syncRuns(projectId ?? ''),
    queryFn: () => weldpass.listSyncRuns(projectId as string, { limit: 25 }),
    select: (res) => res.data,
    enabled: Boolean(projectId),
  });
}

export function useCreateWeldPassSyncTarget(projectId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<
    { data: WeldPassSyncTarget },
    Error,
    {
      environmentId: string;
      credentialId: string;
      name: string;
      config: WeldPassSyncTargetConfig;
      autoSync?: boolean;
      prune?: boolean;
    }
  >({
    mutationFn: (input) => weldpass.createSyncTarget(projectId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.syncTargets(projectId) });
    },
  });
}

export function useUpdateWeldPassSyncTarget(projectId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      targetId: string;
      name?: string;
      autoSync?: boolean;
      prune?: boolean;
    }) =>
      weldpass.updateSyncTarget(projectId, input.targetId, {
        name: input.name,
        autoSync: input.autoSync,
        prune: input.prune,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.syncTargets(projectId) });
    },
  });
}

export function useDeleteWeldPassSyncTarget(projectId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (targetId) => weldpass.deleteSyncTarget(projectId, targetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.syncTargets(projectId) });
    },
  });
}

/**
 * Push one target. Resolves even when the push failed — the run record carries
 * the outcome, so callers read `run.status` rather than catching.
 */
export function usePushWeldPassSyncTarget(projectId: string) {
  const { weldpass } = useAppApi();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (targetId: string) => weldpass.pushSyncTarget(projectId, targetId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: weldpassKeys.syncTargets(projectId) });
      qc.invalidateQueries({ queryKey: weldpassKeys.syncRuns(projectId) });
      qc.invalidateQueries({ queryKey: weldpassKeys.audit(projectId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function useWeldPassAudit(projectId: string | undefined) {
  const { weldpass } = useAppApi();

  return useQuery({
    queryKey: weldpassKeys.audit(projectId ?? ''),
    queryFn: () => weldpass.listAudit(projectId as string, { limit: 100 }),
    select: (res) => res.data,
    enabled: Boolean(projectId),
  });
}
