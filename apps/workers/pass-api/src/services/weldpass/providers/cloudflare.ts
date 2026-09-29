/**
 * Cloudflare deploy targets — Worker script secrets and Pages env vars.
 *
 * All REST access goes through `@weldsuite/cloudflare-deploy`, which wraps the
 * official Cloudflare SDK. Nothing here builds an api.cloudflare.com URL.
 */

import {
  CloudflareDeployError,
  listPagesEnvVarNames,
  listWorkerSecretNames,
  putPagesEnvVars,
  putWorkerSecrets,
  verifyAccountAccess,
} from '@weldsuite/cloudflare-deploy';
import type { WeldPassSyncTargetConfig } from '@weldsuite/db/schema/weldpass';
import {
  ProviderError,
  type PushDetail,
  type PushRequest,
  type PushResult,
  type SyncProvider,
  type VerifyResult,
} from './types';

function wrap(err: unknown): ProviderError {
  if (err instanceof CloudflareDeployError) {
    return new ProviderError(err.message, err.status);
  }
  return new ProviderError(err instanceof Error ? err.message : String(err));
}

/** Keys the vault owns that are no longer present, given what the target holds. */
function keysToRemove(remoteKeys: string[], desired: Record<string, string>): string[] {
  return remoteKeys.filter((key) => !(key in desired));
}

function detailsFor(written: string[], removed: string[]): PushDetail[] {
  return [
    ...written.map((key): PushDetail => ({ key, action: 'pushed' })),
    ...removed.map((key): PushDetail => ({ key, action: 'removed' })),
  ];
}

export const cloudflareWorkersProvider: SyncProvider = {
  id: 'cloudflare_workers',
  label: 'Cloudflare Workers',

  async verify(token, config): Promise<VerifyResult> {
    if (config.provider !== 'cloudflare_workers') {
      throw new ProviderError('Config does not describe a Cloudflare Workers target');
    }
    try {
      const account = await verifyAccountAccess(token, config.accountId);
      // Listing proves the token also reaches this particular script, which is
      // the failure people actually hit (account-wide token, wrong script name).
      await listWorkerSecretNames(token, {
        accountId: config.accountId,
        scriptName: config.scriptName,
      });
      return { ok: true, identity: `${account.name} → ${config.scriptName}` };
    } catch (err) {
      return { ok: false, message: wrap(err).message };
    }
  },

  async push(request: PushRequest): Promise<PushResult> {
    const { config } = request;
    if (config.provider !== 'cloudflare_workers') {
      throw new ProviderError('Config does not describe a Cloudflare Workers target');
    }

    try {
      let remove: string[] = [];
      if (request.prune) {
        const remote = await listWorkerSecretNames(request.token, {
          accountId: config.accountId,
          scriptName: config.scriptName,
        });
        remove = keysToRemove(remote, request.secrets);
      }

      const result = await putWorkerSecrets(request.token, {
        accountId: config.accountId,
        scriptName: config.scriptName,
        secrets: request.secrets,
        remove,
      });

      return {
        pushed: result.written.length,
        removed: result.removed.length,
        failed: 0,
        details: detailsFor(result.written, result.removed),
      };
    } catch (err) {
      throw wrap(err);
    }
  },
};

export const cloudflarePagesProvider: SyncProvider = {
  id: 'cloudflare_pages',
  label: 'Cloudflare Pages',

  async verify(token, config): Promise<VerifyResult> {
    if (config.provider !== 'cloudflare_pages') {
      throw new ProviderError('Config does not describe a Cloudflare Pages target');
    }
    try {
      const account = await verifyAccountAccess(token, config.accountId);
      await listPagesEnvVarNames(token, {
        accountId: config.accountId,
        projectName: config.projectName,
        environment: config.environment,
      });
      return {
        ok: true,
        identity: `${account.name} → ${config.projectName} (${config.environment})`,
      };
    } catch (err) {
      return { ok: false, message: wrap(err).message };
    }
  },

  async push(request: PushRequest): Promise<PushResult> {
    const { config } = request;
    if (config.provider !== 'cloudflare_pages') {
      throw new ProviderError('Config does not describe a Cloudflare Pages target');
    }

    try {
      let remove: string[] = [];
      if (request.prune) {
        const remote = await listPagesEnvVarNames(request.token, {
          accountId: config.accountId,
          projectName: config.projectName,
          environment: config.environment,
        });
        remove = keysToRemove(remote, request.secrets);
      }

      const result = await putPagesEnvVars(request.token, {
        accountId: config.accountId,
        projectName: config.projectName,
        environment: config.environment,
        vars: request.secrets,
        remove,
      });

      return {
        pushed: result.written.length,
        removed: result.removed.length,
        failed: 0,
        details: detailsFor(result.written, result.removed),
      };
    } catch (err) {
      throw wrap(err);
    }
  },
};

/**
 * Pages and Workers both apply new values to the *next* deployment, so a push
 * alone does not change what is currently running. Surfaced in the UI next to
 * the sync button rather than left for people to discover.
 */
export function cloudflareRedeployNotice(config: WeldPassSyncTargetConfig): string | null {
  if (config.provider === 'cloudflare_pages') {
    return 'Cloudflare Pages applies these on the next deployment — redeploy to pick them up.';
  }
  if (config.provider === 'cloudflare_workers') {
    return 'Cloudflare rolls a new Worker version when secrets change; a redeploy is not needed.';
  }
  return null;
}
