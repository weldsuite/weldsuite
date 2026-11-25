/**
 * The storefront API client of a shop host: `@weldsuite/commerce-sdk` as the
 * hosted principal (see lib/hosted-fetch.ts). One client per host, kept.
 */

import { createStorefrontClient, type StorefrontClient } from '@weldsuite/commerce-sdk';
import { hostedFetch, HOSTED_KEY } from '../hosted-fetch';
import { rendererConfig } from './config';

const clients = new Map<string, StorefrontClient>();
const MAX_CLIENTS = 1_000;

export function storefrontFor(host: string): StorefrontClient {
  const existing = clients.get(host);
  if (existing) return existing;
  const config = rendererConfig();
  const client = createStorefrontClient({
    baseUrl: config.apiUrl,
    key: HOSTED_KEY,
    fetch: hostedFetch(config.secret, host),
    // Wait a few seconds and retry once when the API says "too many requests".
    rateLimitRetries: 1,
    maxRetryAfter: 3,
  });
  if (clients.size >= MAX_CLIENTS) clients.delete(clients.keys().next().value as string);
  clients.set(host, client);
  return client;
}
