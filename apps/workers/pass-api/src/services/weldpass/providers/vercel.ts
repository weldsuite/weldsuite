/**
 * Vercel deploy target — project environment variables.
 *
 * Endpoints (https://vercel.com/docs/rest-api):
 *   POST   /v10/projects/{idOrName}/env?upsert=true   create or update, array body
 *   GET    /v9/projects/{idOrName}/env                 list (values hidden for encrypted)
 *   DELETE /v9/projects/{idOrName}/env/{id}            remove one
 *
 * Values go up as `type: "encrypted"`, so they are write-only afterwards — the
 * same guarantee WeldPass makes locally. Team-owned projects need `teamId` on
 * every call or the request resolves against the personal scope and 404s.
 *
 * Unlike Cloudflare there is no bulk upsert that can also delete, so a pruning
 * sync lists first and deletes by variable id.
 */

import {
  ProviderError,
  type PushDetail,
  type PushRequest,
  type PushResult,
  type SyncProvider,
  type VerifyResult,
} from './types';

const API_BASE = 'https://api.vercel.com';

type VercelTarget = 'production' | 'preview' | 'development';

interface VercelEnvVar {
  id: string;
  key: string;
  target?: VercelTarget[];
}

async function vercelFetch<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; teamId?: string } = {},
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (init.teamId) url.searchParams.set('teamId', init.teamId);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (err) {
    throw new ProviderError(
      `Could not reach the Vercel API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await response.text();

  if (!response.ok) {
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Non-JSON error body — keep the truncated text.
    }
    throw new ProviderError(`Vercel API ${response.status}: ${detail}`, response.status);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

function assertVercelConfig(
  config: PushRequest['config'],
): asserts config is Extract<PushRequest['config'], { provider: 'vercel' }> {
  if (config.provider !== 'vercel') {
    throw new ProviderError('Config does not describe a Vercel target');
  }
}

/** Only variables covering every requested target are ours to prune. */
function prunableKeys(
  existing: VercelEnvVar[],
  desired: Record<string, string>,
  targets: VercelTarget[],
): VercelEnvVar[] {
  return existing.filter((row) => {
    if (row.key in desired) return false;
    const rowTargets = row.target ?? [];
    return targets.every((target) => rowTargets.includes(target));
  });
}

/** Upsert every secret in one call, recording a detail per key. Returns the pushed count. */
async function pushSecrets(
  request: PushRequest,
  teamId: string | undefined,
  projectPath: string,
  targets: VercelTarget[],
  details: PushDetail[],
): Promise<number> {
  const keys = Object.keys(request.secrets);
  if (keys.length === 0) return 0;

  const body = keys.map((key) => ({
    key,
    value: request.secrets[key],
    type: 'encrypted' as const,
    target: targets,
  }));

  // `upsert=true` makes this idempotent; without it an existing key is a 409.
  const result = await vercelFetch<{
    failed?: Array<{ error?: { message?: string; key?: string } }>;
  }>(request.token, `/v10/projects/${projectPath}/env?upsert=true`, {
    method: 'POST',
    body,
    teamId,
  });

  const failures = new Map<string, string>();
  for (const failure of result.failed ?? []) {
    const key = failure.error?.key;
    if (key) failures.set(key, failure.error?.message ?? 'Rejected by Vercel');
  }

  let pushed = 0;
  for (const key of keys) {
    const message = failures.get(key);
    if (message) {
      details.push({ key, action: 'failed', message });
    } else {
      details.push({ key, action: 'pushed' });
      pushed += 1;
    }
  }
  return pushed;
}

/** Delete variables that are no longer desired, recording a detail per key. Returns the removed count. */
async function pruneSecrets(
  request: PushRequest,
  teamId: string | undefined,
  projectPath: string,
  targets: VercelTarget[],
  details: PushDetail[],
): Promise<number> {
  const existing = await vercelFetch<{ envs?: VercelEnvVar[] }>(
    request.token,
    `/v9/projects/${projectPath}/env`,
    { teamId },
  );

  let removed = 0;
  for (const row of prunableKeys(existing.envs ?? [], request.secrets, targets)) {
    try {
      await vercelFetch(
        request.token,
        `/v9/projects/${projectPath}/env/${encodeURIComponent(row.id)}`,
        { method: 'DELETE', teamId },
      );
      details.push({ key: row.key, action: 'removed' });
      removed += 1;
    } catch (err) {
      details.push({
        key: row.key,
        action: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return removed;
}

export const vercelProvider: SyncProvider = {
  id: 'vercel',
  label: 'Vercel',

  async verify(token, config): Promise<VerifyResult> {
    assertVercelConfig(config);
    try {
      const project = await vercelFetch<{ name?: string; id?: string }>(
        token,
        `/v9/projects/${encodeURIComponent(config.projectId)}`,
        { teamId: config.teamId },
      );
      return { ok: true, identity: project.name ?? project.id ?? config.projectId };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async push(request: PushRequest): Promise<PushResult> {
    const { config } = request;
    assertVercelConfig(config);

    const targets = config.targets.length > 0 ? config.targets : (['production'] as VercelTarget[]);
    const projectPath = encodeURIComponent(config.projectId);
    const details: PushDetail[] = [];

    const pushed = await pushSecrets(request, config.teamId, projectPath, targets, details);
    const removed = request.prune
      ? await pruneSecrets(request, config.teamId, projectPath, targets, details)
      : 0;

    return {
      pushed,
      removed,
      failed: details.filter((d) => d.action === 'failed').length,
      details,
    };
  },
};

/** Vercel needs a redeploy before new values reach a running deployment. */
export const VERCEL_REDEPLOY_NOTICE =
  'Vercel applies these on the next deployment — redeploy to pick them up.';
