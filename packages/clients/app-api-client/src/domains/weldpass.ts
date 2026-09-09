/**
 * App-API WeldPass domain client — `/api/weldpass/*`.
 *
 * Secret values only ever travel on the two endpoints that are gated on
 * `secrets:reveal` (`reveal`, `exportDotenv`). Everything else returns
 * metadata: key names, lengths, checksums and a short hint, so a list view can
 * render without a value ever reaching the browser.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';

export type WeldPassProviderId = 'cloudflare_workers' | 'cloudflare_pages' | 'vercel';

export type WeldPassSyncTargetConfig =
  | { provider: 'cloudflare_workers'; accountId: string; scriptName: string }
  | {
      provider: 'cloudflare_pages';
      accountId: string;
      projectName: string;
      environment: 'production' | 'preview';
    }
  | {
      provider: 'vercel';
      projectId: string;
      teamId?: string;
      targets: Array<'production' | 'preview' | 'development'>;
    };

export interface WeldPassEnvironment {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  isProduction: boolean;
  sortOrder: number;
  /** Present on project reads; absent on the flat environments list. */
  secretCount?: number;
}

export interface WeldPassProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  rootKeyVersion: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  environments: WeldPassEnvironment[];
}

export interface WeldPassSecret {
  id: string;
  projectId: string;
  environmentId: string;
  key: string;
  note: string | null;
  version: number;
  valueLength: number;
  valueHint: string | null;
  checksum: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeldPassSecretVersion {
  id: string;
  version: number;
  action: string;
  checksum: string;
  createdBy: string | null;
  createdAt: string;
}

export interface WeldPassCredential {
  id: string;
  projectId: string;
  provider: WeldPassProviderId;
  name: string;
  metadata: { accountId?: string; teamId?: string };
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WeldPassSyncTarget {
  id: string;
  projectId: string;
  environmentId: string;
  credentialId: string;
  provider: WeldPassProviderId;
  name: string;
  config: WeldPassSyncTargetConfig;
  autoSync: boolean;
  prune: boolean;
  status: string;
  lastSyncedAt: string | null;
  lastSyncedCount: number;
  lastError: string | null;
  /** What still has to happen on the target for the values to take effect. */
  redeployNotice: string | null;
}

export interface WeldPassSyncRunDetail {
  key: string;
  action: 'pushed' | 'removed' | 'skipped' | 'failed';
  message?: string;
}

export interface WeldPassSyncRun {
  id: string;
  targetId: string;
  environmentId: string;
  status: string;
  trigger: string;
  pushed: number;
  removed: number;
  failed: number;
  error: string | null;
  details: WeldPassSyncRunDetail[];
  triggeredBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface WeldPassAuditEvent {
  id: string;
  environmentId: string | null;
  secretId: string | null;
  actorId: string;
  action: string;
  targetKey: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** Reported next to a write when auto-sync targets ran as a side effect. */
export interface WeldPassAutoSyncOutcome {
  targetId: string;
  name: string;
  status: string;
  pushed: number;
  error: string | null;
}

export interface WeldPassImportResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  skipped: Array<{ line: number; reason: string }>;
  autoSync: WeldPassAutoSyncOutcome[];
}

const base = '/weldpass';

function secretsPath(projectId: string, environmentId: string) {
  return `${base}/projects/${projectId}/environments/${environmentId}/secrets`;
}

export function createWeldPassApi(api: ClientApi) {
  return {
    listProviders(): Promise<DataResponse<Array<{ id: WeldPassProviderId; label: string }>>> {
      return api.get(`${base}/providers`);
    },

    // Projects -------------------------------------------------------------
    listProjects(): Promise<DataResponse<WeldPassProject[]>> {
      return api.get(`${base}/projects`);
    },

    getProject(projectId: string): Promise<DataResponse<WeldPassProject>> {
      return api.get(`${base}/projects/${projectId}`);
    },

    createProject(body: {
      name: string;
      slug?: string;
      description?: string | null;
    }): Promise<DataResponse<WeldPassProject>> {
      return api.post(`${base}/projects`, body);
    },

    updateProject(
      projectId: string,
      body: { name?: string; description?: string | null },
    ): Promise<DataResponse<WeldPassProject>> {
      return api.patch(`${base}/projects/${projectId}`, body);
    },

    deleteProject(projectId: string): Promise<void> {
      return api.delete(`${base}/projects/${projectId}`);
    },

    // Environments ---------------------------------------------------------
    createEnvironment(
      projectId: string,
      body: { name: string; isProduction?: boolean },
    ): Promise<DataResponse<WeldPassEnvironment>> {
      return api.post(`${base}/projects/${projectId}/environments`, body);
    },

    deleteEnvironment(projectId: string, environmentId: string): Promise<void> {
      return api.delete(`${base}/projects/${projectId}/environments/${environmentId}`);
    },

    // Secrets --------------------------------------------------------------
    listSecrets(
      projectId: string,
      environmentId: string,
    ): Promise<DataResponse<WeldPassSecret[]>> {
      return api.get(secretsPath(projectId, environmentId));
    },

    createSecret(
      projectId: string,
      environmentId: string,
      body: { key: string; value: string; note?: string | null },
    ): Promise<
      DataResponse<{
        secret: WeldPassSecret;
        created: boolean;
        autoSync: WeldPassAutoSyncOutcome[];
      }>
    > {
      return api.post(secretsPath(projectId, environmentId), body);
    },

    updateSecret(
      projectId: string,
      environmentId: string,
      secretId: string,
      body: { value?: string; note?: string | null },
    ): Promise<DataResponse<{ secret: WeldPassSecret; autoSync: WeldPassAutoSyncOutcome[] }>> {
      return api.patch(`${secretsPath(projectId, environmentId)}/${secretId}`, body);
    },

    /** Requires `secrets:reveal`. Every call is written to the audit trail. */
    revealSecret(
      projectId: string,
      environmentId: string,
      secretId: string,
    ): Promise<DataResponse<WeldPassSecret & { value: string }>> {
      return api.get(`${secretsPath(projectId, environmentId)}/${secretId}/reveal`);
    },

    deleteSecret(projectId: string, environmentId: string, secretId: string): Promise<void> {
      return api.delete(`${secretsPath(projectId, environmentId)}/${secretId}`);
    },

    listVersions(
      projectId: string,
      environmentId: string,
      secretId: string,
    ): Promise<DataResponse<WeldPassSecretVersion[]>> {
      return api.get(`${secretsPath(projectId, environmentId)}/${secretId}/versions`);
    },

    restoreVersion(
      projectId: string,
      environmentId: string,
      secretId: string,
      version: number,
    ): Promise<DataResponse<{ secret: WeldPassSecret; autoSync: WeldPassAutoSyncOutcome[] }>> {
      return api.post(`${secretsPath(projectId, environmentId)}/${secretId}/restore`, {
        version,
      });
    },

    importDotenv(
      projectId: string,
      environmentId: string,
      body: { content: string; replace?: boolean },
    ): Promise<DataResponse<WeldPassImportResult>> {
      return api.post(`${secretsPath(projectId, environmentId)}/import`, body);
    },

    /** Requires `secrets:reveal`. Returns the whole environment as `.env` text. */
    exportEnvironment(
      projectId: string,
      environmentId: string,
    ): Promise<DataResponse<Record<string, string>>> {
      return api.get(`${secretsPath(projectId, environmentId)}/export`);
    },

    // Provider credentials -------------------------------------------------
    listCredentials(projectId: string): Promise<DataResponse<WeldPassCredential[]>> {
      return api.get(`${base}/projects/${projectId}/credentials`);
    },

    createCredential(
      projectId: string,
      body: {
        provider: WeldPassProviderId;
        name: string;
        token: string;
        metadata?: { accountId?: string; teamId?: string };
      },
    ): Promise<DataResponse<WeldPassCredential>> {
      return api.post(`${base}/projects/${projectId}/credentials`, body);
    },

    verifyCredential(
      projectId: string,
      credentialId: string,
      config: WeldPassSyncTargetConfig,
    ): Promise<DataResponse<{ ok: boolean; identity?: string; message?: string }>> {
      return api.post(`${base}/projects/${projectId}/credentials/${credentialId}/verify`, {
        config,
      });
    },

    deleteCredential(projectId: string, credentialId: string): Promise<void> {
      return api.delete(`${base}/projects/${projectId}/credentials/${credentialId}`);
    },

    // Sync -----------------------------------------------------------------
    listSyncTargets(
      projectId: string,
      params: { environmentId?: string } = {},
    ): Promise<DataResponse<WeldPassSyncTarget[]>> {
      return api.get(
        `${base}/projects/${projectId}/sync-targets${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    createSyncTarget(
      projectId: string,
      body: {
        environmentId: string;
        credentialId: string;
        name: string;
        config: WeldPassSyncTargetConfig;
        autoSync?: boolean;
        prune?: boolean;
      },
    ): Promise<DataResponse<WeldPassSyncTarget>> {
      return api.post(`${base}/projects/${projectId}/sync-targets`, body);
    },

    updateSyncTarget(
      projectId: string,
      targetId: string,
      body: { name?: string; autoSync?: boolean; prune?: boolean },
    ): Promise<DataResponse<WeldPassSyncTarget>> {
      return api.patch(`${base}/projects/${projectId}/sync-targets/${targetId}`, body);
    },

    deleteSyncTarget(projectId: string, targetId: string): Promise<void> {
      return api.delete(`${base}/projects/${projectId}/sync-targets/${targetId}`);
    },

    /** Keys a push would send, without decrypting anything. */
    previewSync(
      projectId: string,
      targetId: string,
    ): Promise<
      DataResponse<{ keys: string[]; prune: boolean; redeployNotice: string | null }>
    > {
      return api.get(`${base}/projects/${projectId}/sync-targets/${targetId}/preview`);
    },

    /**
     * A failed push resolves rather than rejects — the run row records the
     * failure, and the caller renders success and failure from the same shape.
     */
    pushSyncTarget(
      projectId: string,
      targetId: string,
    ): Promise<DataResponse<{ run: WeldPassSyncRun; target: WeldPassSyncTarget }>> {
      return api.post(`${base}/projects/${projectId}/sync-targets/${targetId}/push`, {});
    },

    listSyncRuns(
      projectId: string,
      params: { targetId?: string; limit?: number } = {},
    ): Promise<DataResponse<WeldPassSyncRun[]>> {
      return api.get(
        `${base}/projects/${projectId}/sync-runs${buildQueryString(params as Record<string, unknown>)}`,
      );
    },

    // Audit ----------------------------------------------------------------
    listAudit(
      projectId: string,
      params: { limit?: number; cursor?: string } = {},
    ): Promise<ListResponse<WeldPassAuditEvent>> {
      return api.get(
        `${base}/projects/${projectId}/audit${buildQueryString(params as Record<string, unknown>)}`,
      );
    },
  };
}

export type WeldPassApi = ReturnType<typeof createWeldPassApi>;
