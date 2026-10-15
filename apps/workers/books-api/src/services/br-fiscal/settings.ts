/**
 * The entity's fiscal provider setup: which Focus NFe environment it issues
 * in, the sealed company token per environment (entities.fiscal_credentials_encrypted,
 * sealed like the sales tax engine credentials), and the webhooks registered
 * with Focus so authorizations reach WeldBooks.
 *
 * Webhook security: Focus signs nothing, it only echoes the `authorization`
 * value it was given. So each environment gets a random URL token and a random
 * secret; only their SHA-256 hashes are stored here, the URL token's hash is
 * the KV index key the public route resolves the tenant from, and the route
 * re-reads the document from Focus instead of trusting the payload.
 */

import { schema } from '@weldsuite/worker-kit/db';
import type { Env } from '../../types';
import { hasEncryptionKey, salesTaxRuntimeFromEnv, sealEngineCredentials } from '../sales-tax/runtime';
import { sha256Hex } from '../w9-requests';
import { FiscalDocumentError } from './errors';
import { FocusClient, FiscalProviderError, type FocusEnvironment } from './focus-client';
import type { BrFiscalSettings } from './payload';

type EntityRow = typeof schema.entities.$inferSelect;

export const FISCAL_ENVIRONMENTS: readonly FocusEnvironment[] = ['homologacao', 'producao'];

/** Focus events registered per environment: NF-e, municipal NFS-e and NFS-e Nacional. */
export const FISCAL_WEBHOOK_EVENTS = ['nfe', 'nfse', 'nfsen'] as const;

export const FISCAL_HOOK_KV_PREFIX = 'fiscalhook:';

export function fiscalHookKvKey(tokenHash: string): string {
  return `${FISCAL_HOOK_KV_PREFIX}${tokenHash}`;
}

/** What the KV index entry of a webhook URL token resolves to. */
export interface FiscalHookKvEntry {
  orgId: string;
  entityId: string;
  environment: FocusEnvironment;
  /** SHA-256 of the secret the hooks echo, so a delivery is checked before the tenant is opened. */
  secretHash: string;
}

export interface FiscalWebhookConfig {
  /** SHA-256 of the random token in the webhook URL. */
  tokenHash: string;
  /** SHA-256 of the secret Focus echoes in the Authorization header. */
  secretHash: string;
  hooks: Array<{ id: string; event: string }>;
  registeredAt: string;
}

/** entities.jurisdiction_settings, with the fiscal keys this module keeps. */
export interface FiscalEntitySettings extends BrFiscalSettings {
  fiscalWebhook?: Partial<Record<FocusEnvironment, FiscalWebhookConfig>>;
  /** High-water mark of the received NF-e sync (Focus `versao`), and the environment it belongs to. */
  receivedNfeVersion?: number;
  receivedNfeVersionEnv?: FocusEnvironment;
}

/** The sealed credentials: one Focus company token per environment. */
export type FiscalCredentials = Partial<Record<FocusEnvironment, string>>;

export function fiscalSettingsOf(entity: Pick<EntityRow, 'jurisdictionSettings'>): FiscalEntitySettings {
  return (entity.jurisdictionSettings ?? {}) as FiscalEntitySettings;
}

export function fiscalEnvironmentOf(settings: FiscalEntitySettings): FocusEnvironment {
  return settings.fiscalEnvironment === 'producao' ? 'producao' : 'homologacao';
}

export async function readFiscalCredentials(entity: Pick<EntityRow, 'fiscalCredentialsEncrypted'>, env: Env): Promise<FiscalCredentials> {
  if (!entity.fiscalCredentialsEncrypted) return {};
  try {
    const parsed = JSON.parse(await salesTaxRuntimeFromEnv(env).decrypt(entity.fiscalCredentialsEncrypted)) as FiscalCredentials;
    return {
      ...(typeof parsed.homologacao === 'string' ? { homologacao: parsed.homologacao } : {}),
      ...(typeof parsed.producao === 'string' ? { producao: parsed.producao } : {}),
    };
  } catch (err) {
    console.error('[books-api/br-fiscal] could not open the fiscal credentials:', err instanceof Error ? err.message : 'unknown error');
    throw new FiscalDocumentError('The stored Focus NFe token cannot be read. Enter it again in the fiscal settings.');
  }
}

export async function sealFiscalCredentials(credentials: FiscalCredentials, env: Env): Promise<string | null> {
  if (Object.keys(credentials).length === 0) return null;
  if (!hasEncryptionKey(env)) {
    throw new FiscalDocumentError('Encryption is not configured, so the Focus NFe token can not be stored');
  }
  return sealEngineCredentials(credentials as Record<string, unknown>, env);
}

/** A Focus client for the entity in `environment`, or a refusal when no token is stored for it. */
export async function focusClientFor(
  entity: Pick<EntityRow, 'fiscalCredentialsEncrypted'>,
  env: Env,
  environment: FocusEnvironment,
  fetchImpl?: typeof fetch,
): Promise<FocusClient> {
  const credentials = await readFiscalCredentials(entity, env);
  const token = credentials[environment];
  if (!token) {
    throw new FiscalDocumentError(
      `No Focus NFe token is set for ${environment === 'producao' ? 'production' : 'homologation'}. Add it in the fiscal settings.`,
    );
  }
  return new FocusClient({ token, environment, fetch: fetchImpl });
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Constant-time comparison of two equal-length hex digests. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Remove the hooks of a previous registration (best effort) and the KV entry that pointed at them. */
export async function removeFiscalWebhooks(
  client: FocusClient | null,
  env: Env,
  previous: FiscalWebhookConfig | undefined,
): Promise<void> {
  if (!previous) return;
  await env.WORKSPACE_CACHE.delete(fiscalHookKvKey(previous.tokenHash));
  if (!client) return;
  for (const hook of previous.hooks) {
    try {
      await client.deleteHook(hook.id);
    } catch (err) {
      // A hook already gone, or a token that lost access: nothing left to clean up.
      if (!(err instanceof FiscalProviderError)) throw err;
    }
  }
}

export interface RegisteredFiscalWebhooks {
  config: FiscalWebhookConfig;
  /** The URL Focus posts to. It holds the random token, so it is shown once and never stored. */
  url: string;
  failures: string[];
}

/**
 * Register the NF-e / NFS-e hooks of one environment, replacing a previous
 * registration. Events that Focus refuses are reported in `failures`; the
 * rest stay registered. Throws only when none could be registered.
 */
export async function registerFiscalWebhooks(args: {
  client: FocusClient;
  env: Env;
  orgId: string;
  entityId: string;
  environment: FocusEnvironment;
  /** Public origin of books-api. */
  baseUrl: string;
  previous?: FiscalWebhookConfig;
}): Promise<RegisteredFiscalWebhooks> {
  const { client, env, orgId, entityId, environment, baseUrl } = args;
  await removeFiscalWebhooks(client, env, args.previous);

  const token = randomToken();
  const secret = randomToken();
  const url = `${baseUrl.replace(/\/+$/, '')}/public/fiscal-webhooks/${token}`;
  const hooks: FiscalWebhookConfig['hooks'] = [];
  const failures: string[] = [];
  let lastError: unknown;

  for (const event of FISCAL_WEBHOOK_EVENTS) {
    try {
      const res = await client.createHook({ event, url, authorization: secret });
      const id = res.data.id;
      if (typeof id === 'string' || typeof id === 'number') hooks.push({ id: String(id), event });
    } catch (err) {
      if (!(err instanceof FiscalProviderError)) throw err;
      lastError = err;
      failures.push(`${event}: ${err.detail}`);
    }
  }
  if (hooks.length === 0 && lastError) throw lastError;

  const config: FiscalWebhookConfig = {
    tokenHash: await sha256Hex(token),
    secretHash: await sha256Hex(secret),
    hooks,
    registeredAt: new Date().toISOString(),
  };
  const entry: FiscalHookKvEntry = { orgId, entityId, environment, secretHash: config.secretHash };
  await env.WORKSPACE_CACHE.put(fiscalHookKvKey(config.tokenHash), JSON.stringify(entry));
  return { config, url, failures };
}
