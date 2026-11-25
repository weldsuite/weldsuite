import { createStorefrontClient, type StorefrontClient } from '@weldsuite/commerce-sdk';

import { readConfig, type ConfigProblem, type ShopConfig } from './config';

const read = readConfig(import.meta.env as Record<string, string | undefined>);

/** The build's settings; null when the shop is not set up (the app shows how). */
export const config: ShopConfig | null = 'config' in read ? read.config : null;
export const configProblem: ConfigProblem | null = 'problem' in read ? read.problem : null;

let client: StorefrontClient | undefined;

/** The storefront client with the publishable key. Calls only work from the key's allowed origins. */
export function storefront(): StorefrontClient {
  if (!config) throw new Error(`The shop is not configured (${configProblem}).`);
  client ??= createStorefrontClient({ baseUrl: config.apiUrl, key: config.key, rateLimitRetries: 1, maxRetryAfter: 3 });
  return client;
}
