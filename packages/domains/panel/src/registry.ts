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
