/**
 * Personal and workspace API keys: the answers of `/api/api-keys` and
 * `/api/workspace-api-keys` (app-api). A key's hash never leaves the server;
 * the full key only in the answer that minted it.
 */

import { z } from 'zod';

/**
 * A key as the lists and reads return it. A timestamp the key does not have
 * (never used, no expiry) is left out rather than null.
 */
export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** `wsk_` and the key's first 8 hex characters. */
  keyPrefix: z.string(),
  scopes: z.array(z.string()).nullable(),
  lastUsedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  createdAt: z.string().optional(),
});

export type ApiKey = z.infer<typeof apiKeySchema>;

/** A workspace key: also the member who minted it (no ownership, a record). */
export const workspaceApiKeySchema = apiKeySchema.extend({
  createdBy: z.string(),
});

export type WorkspaceApiKey = z.infer<typeof workspaceApiKeySchema>;

/** A freshly minted key: the one answer that carries the full `key`. */
export const createdApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  keyPrefix: z.string(),
  scopes: z.array(z.string()),
  key: z.string(),
});

export type CreatedApiKey = z.infer<typeof createdApiKeySchema>;
