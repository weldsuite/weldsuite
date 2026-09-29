import type { WeldPassProvider, WeldPassSyncTargetConfig } from '@weldsuite/db/schema/weldpass';

/** One push of a vault environment to one deploy target. */
export interface PushRequest {
  /** Decrypted provider API token. Never logged, never returned. */
  token: string;
  config: WeldPassSyncTargetConfig;
  /** Secret key → plaintext value. */
  secrets: Record<string, string>;
  /** Remove remote keys that no longer exist in the vault. */
  prune: boolean;
}

export type PushDetail = {
  key: string;
  action: 'pushed' | 'removed' | 'skipped' | 'failed';
  message?: string;
};

export interface PushResult {
  pushed: number;
  removed: number;
  failed: number;
  details: PushDetail[];
}

export interface VerifyResult {
  ok: boolean;
  /** Something identifying, e.g. the account or user the token belongs to. */
  identity?: string;
  message?: string;
}

export interface SyncProvider {
  id: WeldPassProvider;
  label: string;
  /** Confirm a stored token still works before anyone relies on it. */
  verify(token: string, config: WeldPassSyncTargetConfig): Promise<VerifyResult>;
  push(request: PushRequest): Promise<PushResult>;
}

/**
 * Provider calls fail in ways worth showing the user (bad token, wrong project
 * name), so the message is surfaced — but it is built from the provider's own
 * error payload and never includes a secret value.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function emptyResult(): PushResult {
  return { pushed: 0, removed: 0, failed: 0, details: [] };
}
