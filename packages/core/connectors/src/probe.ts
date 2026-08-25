/**
 * Remote-only connector probes. These talk to the store API using decrypted
 * credentials and never open a tenant database.
 */

import {
  enabledConnectorSyncs,
  getConnector,
  type ConnectorSyncSettingKey,
} from './catalog';
import { createConnectorProviderClient } from './factory';
import { ConnectorApiError } from './types';

export type ConnectorProbeResource = ConnectorSyncSettingKey;

export interface ConnectorProbeClient {
  hasUpdatesSince(resource: ConnectorProbeResource, since?: string): Promise<boolean>;
  countResource(resource: ConnectorProbeResource): Promise<number>;
}

export function createProbeClient(
  provider: string,
  credentials: Record<string, string>,
): ConnectorProbeClient {
  try {
    const client = createConnectorProviderClient(provider, credentials);
    return {
      hasUpdatesSince: (resource, since) => client.hasUpdatesSince(resource, since),
      countResource: (resource) => client.countResource(resource),
    };
  } catch (err) {
    if (err instanceof ConnectorApiError) throw err;
    throw new ConnectorApiError({
      message: `No probe client for provider '${provider}'`,
      status: 400,
      kind: 'permanent',
    });
  }
}

function resourcesFor(
  provider: string,
  enabledSyncs: string[] | null | undefined,
): ConnectorProbeResource[] {
  const connector = getConnector(provider);
  if (!connector) return [];
  return [...new Set(enabledConnectorSyncs(connector, enabledSyncs).map((sync) => sync.settingKey))];
}

function watermarkFor(
  watermarks: Record<string, string> | null | undefined,
  provider: string,
  resource: ConnectorProbeResource,
): string | undefined {
  const connector = getConnector(provider);
  const model = connector?.syncs.find((s) => s.settingKey === resource)?.model;
  if (model && watermarks?.[model]) return watermarks[model];
  return watermarks?.[resource];
}

export async function probeConnectorUpdates(args: {
  provider: string;
  credentials: Record<string, string>;
  enabledSyncs?: string[] | null;
  watermarks?: Record<string, string> | null;
  client?: ConnectorProbeClient;
}): Promise<{ hasUpdates: boolean; resources: ConnectorProbeResource[] }> {
  const client = args.client ?? createProbeClient(args.provider, args.credentials);
  const resources = resourcesFor(args.provider, args.enabledSyncs);
  const hit: ConnectorProbeResource[] = [];
  for (const resource of resources) {
    const since = watermarkFor(args.watermarks, args.provider, resource);
    if (await client.hasUpdatesSince(resource, since)) hit.push(resource);
  }
  return { hasUpdates: hit.length > 0, resources: hit };
}

export async function connectorRemoteFingerprint(args: {
  provider: string;
  credentials: Record<string, string>;
  enabledSyncs?: string[] | null;
  client?: ConnectorProbeClient;
}): Promise<Record<string, number>> {
  const client = args.client ?? createProbeClient(args.provider, args.credentials);
  const resources = resourcesFor(args.provider, args.enabledSyncs);
  const fingerprint: Record<string, number> = {};
  for (const resource of resources) {
    fingerprint[resource] = await client.countResource(resource);
  }
  return fingerprint;
}

export function fingerprintsEqual(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined,
): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((left[key] ?? 0) !== (right[key] ?? 0)) return false;
  }
  return true;
}
