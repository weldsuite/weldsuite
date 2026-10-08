/**
 * Provider factory and per-country routing.
 *
 * Which providers a workspace is offered is configuration, not code: the
 * `BANK_FEED_PROVIDERS` variable (per environment) lists them per country,
 *
 *     US:stripe_fc,plaid;NL:ponto;*:enable_banking
 *
 * A country gets its own list followed by the `*` list; a provider is offered
 * only when its credentials are configured and its regions cover the country.
 * Unset, every configured provider is offered where its regions allow, in the
 * order plaid, stripe_fc, ponto, enable_banking. (Flagship flags are not used
 * here: the factory also runs in the webhook worker, which has no flag
 * context, and an env var is switchable per environment without a deploy of
 * the flag service.)
 */

import { FeedProviderError } from './errors';
import type { FetchLike } from './http';
import { createEnableBankingProvider, type EnableBankingConfig } from './enable-banking/provider';
import { createPlaidProvider, type PlaidConfig } from './plaid/provider';
import { createPontoProvider, type PontoConfig } from './ponto/provider';
import { createStripeFcProvider, type StripeFcConfig } from './stripe-fc/provider';
import type { BankFeedProvider, KeyCache } from './types';

export interface BankFeedConfig {
  plaid?: PlaidConfig;
  stripeFc?: StripeFcConfig;
  ponto?: PontoConfig;
  enableBanking?: EnableBankingConfig;
  /** `BANK_FEED_PROVIDERS` spec. */
  routing?: string | null;
}

export const DEFAULT_PROVIDER_ORDER = ['plaid', 'stripe_fc', 'ponto', 'enable_banking'] as const;

/** `stripe-fc` and `enable-banking` (URL segments) to the stored ids. */
export function normalizeProviderId(id: string): string {
  return id.trim().toLowerCase().replace(/-/g, '_');
}

export type ProviderRouting = Record<string, string[]>;

export function parseProviderRouting(spec: string | null | undefined): ProviderRouting {
  const routing: ProviderRouting = {};
  for (const part of (spec ?? '').split(';')) {
    const [country, list] = part.split(':');
    if (!country?.trim() || !list) continue;
    routing[country.trim().toUpperCase()] = list
      .split(',')
      .map(normalizeProviderId)
      .filter((id) => id.length > 0);
  }
  return routing;
}

export function configuredProviderIds(config: BankFeedConfig): string[] {
  const ids: string[] = [];
  if (config.plaid) ids.push('plaid');
  if (config.stripeFc) ids.push('stripe_fc');
  if (config.ponto) ids.push('ponto');
  if (config.enableBanking) ids.push('enable_banking');
  return ids;
}

export function createBankFeedProvider(id: string, config: BankFeedConfig): BankFeedProvider {
  switch (normalizeProviderId(id)) {
    case 'plaid':
      if (config.plaid) return createPlaidProvider(config.plaid);
      break;
    case 'stripe_fc':
      if (config.stripeFc) return createStripeFcProvider(config.stripeFc);
      break;
    case 'ponto':
      if (config.ponto) return createPontoProvider(config.ponto);
      break;
    case 'enable_banking':
      if (config.enableBanking) return createEnableBankingProvider(config.enableBanking);
      break;
    default:
      throw new FeedProviderError(id, 'unsupported', `Unknown bank feed provider '${id}'`);
  }
  throw new FeedProviderError(id, 'not_configured', `Bank feed provider '${id}' is not configured`);
}

/**
 * A provider for verifying and parsing webhooks only. Stripe Financial
 * Connections signs deliveries with a webhook secret, so the receiver needs no
 * Stripe API key; Plaid's receiver needs its client credentials (it fetches the
 * verification key), so that one still has to be configured.
 */
export function createWebhookProvider(id: string, config: BankFeedConfig): BankFeedProvider {
  if (normalizeProviderId(id) === 'stripe_fc' && !config.stripeFc) return createStripeFcProvider({ secretKey: '' });
  return createBankFeedProvider(id, config);
}

/** Providers offered for a country, in the order to show them. */
export function enabledProviders(country: string, config: BankFeedConfig): BankFeedProvider[] {
  const code = country.toUpperCase();
  const configured = new Set(configuredProviderIds(config));
  const routing = parseProviderRouting(config.routing);
  const order = config.routing
    ? [...(routing[code] ?? []), ...(routing['*'] ?? [])]
    : [...DEFAULT_PROVIDER_ORDER];

  const providers: BankFeedProvider[] = [];
  for (const id of new Set(order)) {
    if (!configured.has(id)) continue;
    const provider = createBankFeedProvider(id, config);
    if (provider.capabilities.regions.includes(code)) providers.push(provider);
  }
  return providers;
}

/** The environment variables the providers read (worker secrets and vars). */
export interface BankFeedEnv {
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  /** sandbox | production (default sandbox outside production). */
  PLAID_ENV?: string;
  /** Comma separated, default US. */
  PLAID_COUNTRY_CODES?: string;
  /** OAuth redirect URI registered in the Plaid dashboard (needed for OAuth banks). */
  PLAID_REDIRECT_URI?: string;
  STRIPE_FC_SECRET_KEY?: string;
  /** Pinned Stripe-Version for Financial Connections calls (defaults to the package's). */
  STRIPE_FC_API_VERSION?: string;
  PONTO_CLIENT_ID?: string;
  PONTO_CLIENT_SECRET?: string;
  ENABLE_BANKING_APP_ID?: string;
  ENABLE_BANKING_PRIVATE_KEY?: string;
  BANK_FEED_PROVIDERS?: string;
  /** Base URL of the webhook receiver, e.g. `https://integration-webhooks.weldsuite.org/webhooks/bank-feeds`. */
  BANK_FEED_WEBHOOK_URL?: string;
}

export interface BankFeedConfigOptions {
  fetch?: FetchLike;
  /** Plaid verification-key cache (KV). */
  keyCache?: KeyCache;
  /** `env.PONTO_CERT.fetch` (Workers mTLS binding). */
  pontoFetch?: FetchLike;
}

export function bankFeedConfigFromEnv(env: BankFeedEnv, options: BankFeedConfigOptions = {}): BankFeedConfig {
  const config: BankFeedConfig = { routing: env.BANK_FEED_PROVIDERS ?? null };
  const webhookBase = env.BANK_FEED_WEBHOOK_URL?.replace(/\/+$/, '');

  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) {
    config.plaid = {
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      env: env.PLAID_ENV === 'production' ? 'production' : 'sandbox',
      webhookUrl: webhookBase ? `${webhookBase}/plaid` : undefined,
      redirectUri: env.PLAID_REDIRECT_URI || undefined,
      countryCodes: env.PLAID_COUNTRY_CODES ? env.PLAID_COUNTRY_CODES.split(',').map((c) => c.trim().toUpperCase()) : undefined,
      keyCache: options.keyCache,
      fetch: options.fetch,
    };
  }
  if (env.STRIPE_FC_SECRET_KEY) {
    config.stripeFc = { secretKey: env.STRIPE_FC_SECRET_KEY, apiVersion: env.STRIPE_FC_API_VERSION || undefined, fetch: options.fetch };
  }
  if (env.PONTO_CLIENT_ID && env.PONTO_CLIENT_SECRET) {
    config.ponto = {
      clientId: env.PONTO_CLIENT_ID,
      clientSecret: env.PONTO_CLIENT_SECRET,
      fetch: options.pontoFetch ?? options.fetch,
    };
  }
  if (env.ENABLE_BANKING_APP_ID && env.ENABLE_BANKING_PRIVATE_KEY) {
    config.enableBanking = {
      appId: env.ENABLE_BANKING_APP_ID,
      privateKey: env.ENABLE_BANKING_PRIVATE_KEY,
      fetch: options.fetch,
    };
  }
  return config;
}
