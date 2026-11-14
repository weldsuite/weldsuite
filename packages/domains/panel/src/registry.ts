/**
 * The project record the collector reads, and the KV keys around it.
 *
 * panel-api is the only writer: whenever a project is created, changed, has
 * its token rotated or is deleted, it upserts the master
 * `panel_project_registry` row and puts (or deletes) the KV record below.
 * The tenant `panel_projects` row stays the source of truth; the registry
 * routes, KV caches the registry (ADR PANEL-001, DATA-009).
 *
 * panel-ingest reads only KV, never a database. Both workers bind the shared
 * `WORKSPACE_CACHE` namespace; every WeldPanel key starts with `panel:`.
 */

import { isDeviceClass, type DeviceClass } from './device-class';
import type { ReplayTier } from './replays';
import type { PanelProjectSettings } from './settings';

export const PANEL_KV_PREFIX = 'panel:';

/** `panel:project:<token>` → {@link PanelProjectRecord} (JSON). Written by panel-api. */
export function projectKvKey(token: string): string {
  return `${PANEL_KV_PREFIX}project:${token}`;
}

/**
 * `panel:seen:<projectId>` → ISO time of the last event the collector accepted
 * for the project. Written by panel-ingest at most every few minutes per
 * isolate; panel-api reads it for the install check.
 */
export function seenKvKey(projectId: string): string {
  return `${PANEL_KV_PREFIX}seen:${projectId}`;
}

/**
 * `panel:key:<sha256 hex of the secret key>` → {@link PanelKeyRecord} (JSON).
 * Written by panel-api when a secret key (`wps_…`) is created, deleted when it
 * is revoked; the master `panel_key_registry` row is the source of truth.
 * panel-ingest's `/v1/track` and `/v1/import` read only this.
 */
export function keyKvKey(keyHash: string): string {
  return `${PANEL_KV_PREFIX}key:${keyHash}`;
}

export interface PanelKeyRecord {
  v: 1;
  keyId: string;
  workspaceId: string;
  projectId: string;
  /**
   * The project's status when the record was last written. panel-api rewrites
   * every key's record when the project is paused or resumed, and the
   * collector drops a paused project's `/v1/*` traffic. Missing means active
   * (records written before this field existed).
   */
  status?: 'active' | 'paused';
}

/** Parses a KV value; null for a missing, malformed or unknown-version record. */
export function parseKeyRecord(raw: string | null): PanelKeyRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PanelKeyRecord>;
    if (
      value.v !== 1 ||
      typeof value.keyId !== 'string' ||
      typeof value.workspaceId !== 'string' ||
      typeof value.projectId !== 'string'
    ) {
      return null;
    }
    return {
      v: 1,
      keyId: value.keyId,
      workspaceId: value.workspaceId,
      projectId: value.projectId,
      ...(value.status === 'paused' || value.status === 'active' ? { status: value.status } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * `panel:snapshot-request:<projectId>` → {@link PanelSnapshotRequest} (JSON).
 * Written by panel-api when a heatmap has no recording to take its background
 * from; read by `GET /c/:token` (the SDK then sends one masked snapshot to
 * `POST /snap`) and by `POST /snap`, which accepts only the snapshot asked
 * for and deletes the key once it is stored.
 */
export function snapshotRequestKvKey(projectId: string): string {
  return `${PANEL_KV_PREFIX}snapshot-request:${projectId}`;
}

export interface PanelSnapshotRequest {
  pageGroupId: string;
  urlPattern: string;
  deviceClass: DeviceClass;
}

/** Page group ids end up in an R2 key and a query string: word characters and dashes only. */
export const PAGE_GROUP_ID = /^[\w-]{1,64}$/;

/** Parses the KV value; null for a missing or malformed request. */
export function parseSnapshotRequest(raw: string | null): PanelSnapshotRequest | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PanelSnapshotRequest>;
    if (
      typeof value.pageGroupId !== 'string' ||
      !PAGE_GROUP_ID.test(value.pageGroupId) ||
      typeof value.urlPattern !== 'string' ||
      value.urlPattern.length === 0 ||
      !isDeviceClass(value.deviceClass)
    ) {
      return null;
    }
    return { pageGroupId: value.pageGroupId, urlPattern: value.urlPattern, deviceClass: value.deviceClass };
  } catch {
    return null;
  }
}

/**
 * `panel:quota:<workspaceId>` → {@link PanelQuotaState} (plain string).
 * Written by panel-api's usage settlement; read by the collector on every
 * batch (cached per isolate for a minute). Missing = `ok`.
 */
export function quotaKvKey(workspaceId: string): string {
  return `${PANEL_KV_PREFIX}quota:${workspaceId}`;
}

/** `replay_blocked`: no new recordings. `events_blocked`: events dropped too (recordings stay blocked). */
export const PANEL_QUOTA_STATES = ['ok', 'replay_blocked', 'events_blocked'] as const;
export type PanelQuotaState = (typeof PANEL_QUOTA_STATES)[number];

export function parseQuotaState(raw: string | null): PanelQuotaState {
  return raw === 'replay_blocked' || raw === 'events_blocked' ? raw : 'ok';
}

/** What the collector needs to accept, enrich and route an event. Versioned: bump `v` on a breaking change. */
export interface PanelProjectRecord {
  v: 1;
  projectId: string;
  /** Master `workspaces.id` (`ws_…`). */
  workspaceId: string;
  status: 'active' | 'paused';
  /** Hosts events are accepted from (subdomains included). Empty = any. */
  allowedDomains: string[];
  settings: PanelProjectSettings;
  /**
   * The retention tier new recording chunks go to (`90d` on Scale and
   * Enterprise). Written by panel-api's billing; missing means `30d`.
   */
  replayTier?: Extract<ReplayTier, '30d' | '90d'>;
}

export function toProjectRecord(project: {
  id: string;
  status: 'active' | 'paused';
  allowedDomains: string[];
  settings: PanelProjectSettings;
}, workspaceId: string): PanelProjectRecord {
  return {
    v: 1,
    projectId: project.id,
    workspaceId,
    status: project.status,
    allowedDomains: project.allowedDomains,
    settings: project.settings,
  };
}

/** Parses a KV value; null for a missing, malformed or unknown-version record. */
export function parseProjectRecord(raw: string | null): PanelProjectRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PanelProjectRecord>;
    if (value.v !== 1 || typeof value.projectId !== 'string' || typeof value.workspaceId !== 'string') return null;
    return value as PanelProjectRecord;
  } catch {
    return null;
  }
}

/**
 * Whether `origin` (an `Origin` header, `https://shop.example.com`) is allowed:
 * any origin when the list is empty, else an exact host or a subdomain of a
 * listed host. Entries are bare hosts (`example.com`), compared case-insensitively.
 */
export function isAllowedOrigin(origin: string | null, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedDomains.some((domain) => {
    const d = domain.trim().toLowerCase().replace(/^\*\./, '');
    return d.length > 0 && (host === d || host.endsWith(`.${d}`));
  });
}
