/**
 * Public share links to a report or a dashboard.
 *
 * The token (`wpsh_` + 32 letters and digits) is shown once; only its SHA-256
 * is kept, in the tenant `panel_share_links` row and in the master
 * `panel_share_registry` (which the public route reads to find the workspace
 * without trying every tenant DB). Revoking stamps both.
 *
 * People data never leaves through a link: a report is refused (at creation,
 * and again at every public view, since it may have changed) when its kind is
 * not an aggregate one or a breakdown uses a person property or the free-text
 * `el_text` / full `url` columns. The public metadata carries specs with every
 * filter value, cohort id and the project id taken out.
 */

import { and, asc, count, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  getWorkspaceContextForOrg,
  masterSchema,
  schema,
  type AnyMasterDatabase,
  type Database,
} from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { ALPHANUMERIC, randomString } from '@weldsuite/worker-kit/random';
import type { PanelDashboard, PanelDashboardTile, PanelProject, PanelReport, PanelShareLink } from '@weldsuite/db/schema';
import { applyPanelDashboardFilters } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import {
  PANEL_DATE_PRESETS,
  type PanelDateRange,
  type ParsedPanelQuerySpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import {
  PANEL_SHARE_TOKEN,
  PANEL_SHAREABLE_KINDS,
  PANEL_UNSHAREABLE_COLUMNS,
  type CreatePanelShareLinkInput,
  type PanelPublicReport,
  type PanelPublicShareDto,
  type PanelPublicTile,
  type PanelShareLinkDto,
  type PanelShareRefusal,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { Env } from '../types';
import { parseDashboardFilters, tileSpec } from './dashboard-filters';
import { sha256Hex } from './keys';
import { canSee, getTarget, listTiles, tileReports, type Actor, type PanelTarget } from './saved-objects';

const { panelProjects, panelShareLinks } = schema;
const { panelShareRegistry } = masterSchema;

/** `wpsh_` and the first four characters: what the list shows. */
const PREFIX_LENGTH = 9;
/** Live (not revoked) links one report or dashboard may have at once. */
export const MAX_ACTIVE_LINKS_PER_TARGET = 20;
/** A link's views are counted at most once a minute (one tenant write a minute, whatever the traffic). */
export const VIEW_COUNT_INTERVAL_MS = 60_000;

export function generateShareToken(): string {
  return `wpsh_${randomString(32, ALPHANUMERIC)}`;
}

export function toShareLinkDto(row: PanelShareLink): PanelShareLinkDto {
  return {
    id: row.id,
    projectId: row.projectId,
    targetType: row.targetType,
    targetId: row.targetId,
    prefix: `${row.tokenPrefix}…`,
    allowEmbed: row.allowEmbed,
    allowDateChange: row.allowDateChange,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
    viewCount: row.viewCount,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The payload of a `panel_share_link` event: the token's prefix, never the token. */
export function shareLinkEventData(row: PanelShareLink) {
  return { id: row.id, projectId: row.projectId, targetType: row.targetType, targetId: row.targetId, prefix: `${row.tokenPrefix}…` };
}

// ---------------------------------------------------------------------------
// What may be shared
// ---------------------------------------------------------------------------

/** The breakdowns of a stored spec, wherever the spec keeps one. */
function breakdownsOf(spec: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
  };
  add(spec.breakdown);
  add(spec.holdConstant);
  if (Array.isArray(spec.breakdowns)) spec.breakdowns.forEach(add);
  return out;
}

/** Why a report may not be shown on a public link (empty: it may). */
export function shareRefusals(report: Pick<PanelReport, 'kind' | 'spec'>): PanelShareRefusal[] {
  const reasons = new Set<PanelShareRefusal>();
  const shareable = PANEL_SHAREABLE_KINDS as readonly string[];
  if (!shareable.includes(report.kind) || (typeof report.spec.kind === 'string' && !shareable.includes(report.spec.kind))) {
    reasons.add('kind');
  }
  for (const breakdown of breakdownsOf(report.spec)) {
    if (breakdown.source === 'person') reasons.add('person_breakdown');
    if (breakdown.source === 'column' && typeof breakdown.field === 'string' && PANEL_UNSHAREABLE_COLUMNS.includes(breakdown.field)) {
      reasons.add('column_breakdown');
    }
  }
  return [...reasons];
}

/** Every reason the target (a report, or each report on a dashboard) may not be shared. */
export async function targetRefusals(db: Database, target: PanelTarget): Promise<{ reportId: string; reason: PanelShareRefusal }[]> {
  const reports = target.targetType === 'report' ? [target.row] : [...(await tileReports(db, await listTiles(db, target.row.id))).values()];
  return reports.flatMap((r) => shareRefusals(r).map((reason) => ({ reportId: r.id, reason })));
}

/**
 * A spec as a public page shows it: the project id, every filter value and
 * every cohort id taken out (the filters themselves stay, so the page can say
 * the report is filtered).
 */
export function publicSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>;
    const isFilter = 'source' in object && ('operator' in object || object.source === 'cohort');
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(object)) {
      if (isFilter && (key === 'value' || key === 'cohortId')) continue;
      out[key] = strip(inner);
    }
    return out;
  };
  const rest: Record<string, unknown> = { ...spec };
  delete rest.projectId;
  return strip(rest) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Members: create, list, revoke
// ---------------------------------------------------------------------------

export class ShareLinkError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

export async function countActiveLinks(db: Database, target: PanelTarget): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(panelShareLinks)
    .where(and(eq(panelShareLinks.targetType, target.targetType), eq(panelShareLinks.targetId, target.row.id), isNull(panelShareLinks.revokedAt)));
  return Number(row?.n ?? 0);
}

/**
 * Creates the link (tenant row, then the master registry row; the tenant row
 * is removed again when the registry write fails). Answers the row and the
 * token, which is never stored.
 */
export async function createShareLink(
  db: Database,
  masterDb: AnyMasterDatabase,
  params: { workspaceId: string; target: PanelTarget; input: CreatePanelShareLinkInput; userId: string; now?: Date },
): Promise<{ link: PanelShareLink; token: string }> {
  const { workspaceId, target, input, userId } = params;
  const now = params.now ?? new Date();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) throw new ShareLinkError('The expiry date must be in the future', 400);
  if ((await countActiveLinks(db, target)) >= MAX_ACTIVE_LINKS_PER_TARGET) {
    throw new ShareLinkError(`At most ${MAX_ACTIVE_LINKS_PER_TARGET} links per ${target.targetType}; revoke one first`, 409);
  }

  const token = generateShareToken();
  const tokenHash = await sha256Hex(token);
  const [link] = await db
    .insert(panelShareLinks)
    .values({
      id: generateId('pnsl'),
      projectId: target.row.projectId,
      targetType: target.targetType,
      targetId: target.row.id,
      tokenHash,
      tokenPrefix: token.slice(0, PREFIX_LENGTH),
      allowEmbed: input.allowEmbed ?? false,
      allowDateChange: input.allowDateChange ?? false,
      expiresAt,
      createdByUserId: userId,
    })
    .returning();
  const row = link as PanelShareLink;
  try {
    await masterDb.insert(panelShareRegistry).values({ tokenHash, workspaceId, projectId: row.projectId, linkId: row.id, expiresAt });
  } catch (err) {
    await db.delete(panelShareLinks).where(eq(panelShareLinks.id, row.id));
    throw err;
  }
  return { link: row, token };
}

export async function listShareLinks(db: Database, targetType: 'report' | 'dashboard', targetId: string): Promise<PanelShareLink[]> {
  return db
    .select()
    .from(panelShareLinks)
    .where(and(eq(panelShareLinks.targetType, targetType), eq(panelShareLinks.targetId, targetId)))
    .orderBy(desc(panelShareLinks.createdAt), asc(panelShareLinks.id))
    .limit(100);
}

export async function getShareLink(db: Database, id: string): Promise<PanelShareLink | null> {
  const [row] = await db.select().from(panelShareLinks).where(eq(panelShareLinks.id, id)).limit(1);
  return row ?? null;
}

/** Revokes the link in the tenant row and the master registry. Safe to repeat. */
export async function revokeShareLink(db: Database, masterDb: AnyMasterDatabase, workspaceId: string, link: PanelShareLink): Promise<PanelShareLink> {
  const now = new Date();
  const [row] = await db
    .update(panelShareLinks)
    .set({ revokedAt: link.revokedAt ?? now })
    .where(eq(panelShareLinks.id, link.id))
    .returning();
  await masterDb
    .update(panelShareRegistry)
    .set({ revokedAt: link.revokedAt ?? now })
    .where(and(eq(panelShareRegistry.tokenHash, link.tokenHash), eq(panelShareRegistry.workspaceId, workspaceId)));
  return row ?? link;
}

// ---------------------------------------------------------------------------
// Public: open a link, describe it, run its reports
// ---------------------------------------------------------------------------

export interface OpenedShare {
  /** `workspaces.id`. */
  workspaceId: string;
  db: Database;
  link: PanelShareLink;
  project: PanelProject;
  target: PanelTarget;
}

const expired = (at: Date | null, now: Date) => at !== null && at.getTime() <= now.getTime();

/**
 * The link behind a token, its workspace's tenant DB, project and target, or
 * null for anything wrong: a malformed, unknown, revoked or expired token, a
 * suspended workspace, a deleted project or target, a target the link's
 * creator can no longer see, or a report that may no longer be shared.
 */
export async function openShare(env: Env, masterDb: AnyMasterDatabase, token: string, now = new Date()): Promise<OpenedShare | null> {
  if (!PANEL_SHARE_TOKEN.test(token)) return null;
  const tokenHash = await sha256Hex(token);
  const [entry] = await masterDb.select().from(panelShareRegistry).where(eq(panelShareRegistry.tokenHash, tokenHash)).limit(1);
  if (!entry || entry.revokedAt || expired(entry.expiresAt, now)) return null;

  let db: Database;
  try {
    const workspace = await getWorkspaceContextForOrg(env, entry.workspaceId);
    if (workspace.suspended) return null;
    db = workspace.db;
  } catch {
    return null;
  }

  const [link] = await db
    .select()
    .from(panelShareLinks)
    .where(and(eq(panelShareLinks.id, entry.linkId), eq(panelShareLinks.tokenHash, tokenHash)))
    .limit(1);
  if (!link || link.revokedAt || expired(link.expiresAt, now)) return null;

  const [project] = await db
    .select()
    .from(panelProjects)
    .where(and(eq(panelProjects.id, link.projectId), isNull(panelProjects.deletedAt)))
    .limit(1);
  if (!project) return null;

  const target = await getTarget(db, link.targetType, link.targetId);
  if (!target || target.row.projectId !== project.id || !canSee(target.row, creatorOf(link))) return null;
  if (target.targetType === 'report' && shareRefusals(target.row).length > 0) return null;
  return { workspaceId: entry.workspaceId, db, link, project, target };
}

/** The link's creator as an actor: what the link shows is what they may see. */
function creatorOf(link: PanelShareLink): Actor {
  return { userId: link.createdByUserId, canManage: false };
}

/** Counts a view, at most once per {@link VIEW_COUNT_INTERVAL_MS}. */
export async function recordView(db: Database, link: PanelShareLink, now = new Date()): Promise<void> {
  const before = new Date(now.getTime() - VIEW_COUNT_INTERVAL_MS);
  await db
    .update(panelShareLinks)
    .set({ viewCount: sql`${panelShareLinks.viewCount} + 1`, lastViewedAt: now })
    .where(and(eq(panelShareLinks.id, link.id), or(isNull(panelShareLinks.lastViewedAt), lt(panelShareLinks.lastViewedAt, before))));
}

function toPublicReport(report: PanelReport, spec: Record<string, unknown>): PanelPublicReport {
  return { name: report.name, description: report.description, kind: report.kind, spec: publicSpec(spec) };
}

/** A dashboard's report tiles a link may show: live, seen by the link's creator, shareable. */
async function shownTiles(opened: OpenedShare, dashboard: PanelDashboard): Promise<{ tiles: PanelDashboardTile[]; reports: Map<string, PanelReport> }> {
  const tiles = await listTiles(opened.db, dashboard.id);
  const all = await tileReports(opened.db, tiles);
  const reports = new Map([...all].filter(([, r]) => canSee(r, creatorOf(opened.link)) && shareRefusals(r).length === 0));
  return { tiles: tiles.filter((t) => t.kind === 'text' || (t.reportId !== null && reports.has(t.reportId))), reports };
}

/** `GET /public/panel/share/:token`. */
export async function publicShareDto(opened: OpenedShare): Promise<PanelPublicShareDto> {
  const { link, project, target } = opened;
  const base = {
    targetType: target.targetType,
    name: target.row.name,
    description: target.row.description,
    projectName: project.name,
    allowEmbed: link.allowEmbed,
    allowDateChange: link.allowDateChange,
    datePresets: link.allowDateChange ? [...PANEL_DATE_PRESETS] : [],
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
  if (target.targetType === 'report') return { ...base, report: toPublicReport(target.row, target.row.spec), tiles: [] };

  const filters = parseDashboardFilters(target.row.filters);
  const { tiles, reports } = await shownTiles(opened, target.row);
  const shown: PanelPublicTile[] = tiles.map((tile) => {
    const report = tile.reportId ? reports.get(tile.reportId) : undefined;
    return {
      id: tile.id,
      kind: tile.kind,
      layout: tile.layout,
      text: tile.kind === 'text' ? tile.text : null,
      report: report ? toPublicReport(report, applyPanelDashboardFilters(report.spec, filters)) : null,
    };
  });
  return { ...base, report: null, tiles: shown };
}

/**
 * The spec a public results request runs, or null when the request names
 * nothing the link shows (a tile of a shared report, an unknown or text
 * tile). A preset is honoured only when the link allows date changes.
 */
export async function publicResultSpec(
  opened: OpenedShare,
  input: { tileId?: string; dateRange?: PanelDateRange },
): Promise<ParsedPanelQuerySpec | null> {
  const dateRange = opened.link.allowDateChange ? input.dateRange : undefined;
  const { target } = opened;
  if (target.targetType === 'report') {
    if (input.tileId !== undefined) return null;
    return tileSpec(target.row.spec, null, dateRange);
  }
  if (input.tileId === undefined) return null;
  const { tiles, reports } = await shownTiles(opened, target.row);
  const tile = tiles.find((t) => t.id === input.tileId && t.kind === 'report');
  const report = tile?.reportId ? reports.get(tile.reportId) : undefined;
  if (!report) return null;
  return tileSpec(report.spec, parseDashboardFilters(target.row.filters), dateRange);
}
