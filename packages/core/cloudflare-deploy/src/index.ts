/**
 * @weldsuite/cloudflare-deploy
 *
 * Writing environment variables and secrets onto deployed Cloudflare targets:
 * Worker script secrets and Pages project environment variables. This is what
 * WeldPass pushes a vault environment through, and what `scripts/secrets/*`
 * does today by shelling out to `wrangler`.
 *
 * Backed by the official `cloudflare` SDK via `cloudflare/tree-shakable`, so
 * only the two resources used here are bundled (the full client is ~2 MB).
 * The bulk secrets endpoint takes at most 100 operations per request, which is
 * handled here rather than by every caller.
 *
 * SDK: https://github.com/cloudflare/cloudflare-typescript
 */

import { createClient } from 'cloudflare/tree-shakable';
import { APIError } from 'cloudflare/core/error';
import { BaseSecrets } from 'cloudflare/resources/workers/scripts/secrets';
import { BaseProjects } from 'cloudflare/resources/pages/projects/projects';
import { BaseAccounts } from 'cloudflare/resources/accounts/accounts';
import type { ClientOptions } from 'cloudflare/client';

/** Cloudflare's documented ceiling for one bulk-secrets request. */
const BULK_SECRET_LIMIT = 100;

export class CloudflareDeployError extends Error {
  constructor(
    readonly kind: 'AUTH_FAILED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UNKNOWN',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CloudflareDeployError';
  }
}

/** The SDK's `fetch` signature, exported so tests can type their stub. */
export type DeployFetch = NonNullable<ClientOptions['fetch']>;

/**
 * Tests set this to intercept the SDK's transport. The SDK captures its own
 * `fetch` reference, so patching `globalThis.fetch` does not reach it. Never
 * set in production.
 */
let testFetch: DeployFetch | undefined;

/** @internal Test-only. Pass `undefined` to restore the real transport. */
export function __setDeployFetchForTests(fetch: DeployFetch | undefined): void {
  testFetch = fetch;
}

function client(apiToken: string) {
  return createClient({
    apiToken,
    maxRetries: 2,
    timeout: 20_000,
    ...(testFetch ? { fetch: testFetch } : {}),
    resources: [BaseSecrets, BaseProjects, BaseAccounts],
  });
}

function toDeployError(err: unknown, what: string): CloudflareDeployError {
  if (!(err instanceof APIError)) {
    return new CloudflareDeployError(
      'UNKNOWN',
      `${what}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const detail =
    (err.errors ?? [])
      .map((e) => String(e.message ?? ''))
      .filter(Boolean)
      .join('; ') || err.message;

  const kind: CloudflareDeployError['kind'] =
    err.status === 401 || err.status === 403
      ? 'AUTH_FAILED'
      : err.status === 404
        ? 'NOT_FOUND'
        : err.status === 429
          ? 'RATE_LIMITED'
          : 'UNKNOWN';

  return new CloudflareDeployError(kind, `${what}: ${detail}`, err.status);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** Confirm a token can reach an account, and report the account's name. */
export async function verifyAccountAccess(
  apiToken: string,
  accountId: string,
): Promise<{ accountId: string; name: string }> {
  try {
    const account = await client(apiToken).accounts.get({ account_id: accountId });
    return { accountId, name: account?.name ?? accountId };
  } catch (err) {
    throw toDeployError(err, `Cloudflare account ${accountId} is not reachable with this token`);
  }
}

// ---------------------------------------------------------------------------
// Worker script secrets
// ---------------------------------------------------------------------------

export interface WorkerSecretsInput {
  accountId: string;
  /** Deployed script name, e.g. "weldsuite-app-api-test". */
  scriptName: string;
  /** Secret name → value. Every entry is written as `secret_text`. */
  secrets: Record<string, string>;
  /** Secret names to remove. */
  remove?: string[];
}

export interface WorkerSecretsResult {
  written: string[];
  removed: string[];
}

/** Secret names currently set on a Worker. Values are never returned by the API. */
export async function listWorkerSecretNames(
  apiToken: string,
  input: { accountId: string; scriptName: string },
): Promise<string[]> {
  try {
    const names: string[] = [];
    const page = await client(apiToken).workers.scripts.secrets.list(input.scriptName, {
      account_id: input.accountId,
    });
    for await (const secret of page) {
      if (secret.name) names.push(secret.name);
    }
    return names;
  } catch (err) {
    throw toDeployError(err, `Could not list secrets on Worker "${input.scriptName}"`);
  }
}

/**
 * Create/update (and optionally delete) Worker secrets.
 *
 * Secrets not mentioned are left alone — this never wipes a Worker's existing
 * configuration, which matters because WeldPass is usually not the only thing
 * that has ever set a secret on a given script.
 */
export async function putWorkerSecrets(
  apiToken: string,
  input: WorkerSecretsInput,
): Promise<WorkerSecretsResult> {
  type SecretText = { name: string; text: string; type: 'secret_text' };
  const entries: Array<[string, SecretText | null]> = [];

  for (const [name, text] of Object.entries(input.secrets)) {
    entries.push([name, { name, text, type: 'secret_text' }]);
  }
  for (const name of input.remove ?? []) {
    entries.push([name, null]);
  }

  if (entries.length === 0) return { written: [], removed: [] };

  const api = client(apiToken);

  for (const batch of chunk(entries, BULK_SECRET_LIMIT)) {
    try {
      await api.workers.scripts.secrets.bulkUpdate(input.scriptName, {
        account_id: input.accountId,
        secrets: Object.fromEntries(batch),
      });
    } catch (err) {
      throw toDeployError(err, `Could not write secrets to Worker "${input.scriptName}"`);
    }
  }

  return { written: Object.keys(input.secrets), removed: input.remove ?? [] };
}

// ---------------------------------------------------------------------------
// Pages project environment variables
// ---------------------------------------------------------------------------

/** Pages only has these two deployment configs. */
export type PagesEnvironment = 'production' | 'preview';

export interface PagesEnvVarsInput {
  accountId: string;
  projectName: string;
  environment: PagesEnvironment;
  /** Variable name → value. Written as `secret_text` (encrypted at rest). */
  vars: Record<string, string>;
  /** Variable names to remove from this environment. */
  remove?: string[];
}

export interface PagesEnvVarsResult {
  written: string[];
  removed: string[];
}

/** Variable names currently configured on one Pages deployment config. */
export async function listPagesEnvVarNames(
  apiToken: string,
  input: { accountId: string; projectName: string; environment: PagesEnvironment },
): Promise<string[]> {
  try {
    const project = await client(apiToken).pages.projects.get(input.projectName, {
      account_id: input.accountId,
    });
    const config = project?.deployment_configs?.[input.environment];
    return Object.keys(config?.env_vars ?? {});
  } catch (err) {
    throw toDeployError(err, `Could not read Pages project "${input.projectName}"`);
  }
}

/**
 * Set (and optionally clear) environment variables on one Pages deployment
 * config. Cloudflare treats a `null` entry as a delete and leaves unmentioned
 * variables untouched.
 *
 * Pages applies these to the *next* deployment — an existing deployment keeps
 * the values it was built with.
 */
export async function putPagesEnvVars(
  apiToken: string,
  input: PagesEnvVarsInput,
): Promise<PagesEnvVarsResult> {
  const envVars: Record<string, { type: 'secret_text'; value: string } | null> = {};
  for (const [name, value] of Object.entries(input.vars)) {
    envVars[name] = { type: 'secret_text', value };
  }
  for (const name of input.remove ?? []) {
    envVars[name] = null;
  }

  if (Object.keys(envVars).length === 0) {
    return { written: [], removed: [] };
  }

  try {
    await client(apiToken).pages.projects.edit(input.projectName, {
      account_id: input.accountId,
      deployment_configs: { [input.environment]: { env_vars: envVars } },
    });
  } catch (err) {
    throw toDeployError(err, `Could not write env vars to Pages project "${input.projectName}"`);
  }

  return { written: Object.keys(input.vars), removed: input.remove ?? [] };
}
