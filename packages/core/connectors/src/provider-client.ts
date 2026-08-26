/**
 * Shared surface every first-party connector client implements so sync,
 * probe, and webhook registration do not `instanceof` a provider.
 */

import type { ConnectorSyncDef, ConnectorSyncSettingKey } from './catalog';
import type { ConnectorWebhookTopic } from './webhooks';

export interface ConnectorListPage {
  items: Array<Record<string, unknown>>;
  done: boolean;
  nextCursor: string | null;
}

export interface ConnectorWebhookCreated {
  id: string;
  topic: string;
  deliveryUrl: string;
  /** Provider-issued signing secret. Moneybird returns this only at create. */
  secret?: string;
}

export interface ConnectorProviderClient {
  readonly storeUrl: string;
  test(): Promise<{ ok: true; storeUrl: string } | { ok: false; message: string }>;
  listSync(
    sync: ConnectorSyncDef,
    options: {
      page: number;
      cursor: string | null;
      limit: number;
      modifiedAfter?: string;
    },
  ): Promise<ConnectorListPage>;
  hasUpdatesSince(resource: ConnectorSyncSettingKey, since?: string): Promise<boolean>;
  countResource(resource: ConnectorSyncSettingKey): Promise<number>;
  registerWebhooks(args: {
    deliveryUrl: string;
    secret: string;
    topics: ConnectorWebhookTopic[];
  }): Promise<ConnectorWebhookCreated[]>;
  deleteWebhook(id: string): Promise<void>;
}
