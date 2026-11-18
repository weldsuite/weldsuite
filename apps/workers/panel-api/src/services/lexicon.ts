/**
 * Lexicon: the event and property names seen in the last 30 days (a Basin
 * scan, cached about an hour) merged with the team's definitions
 * (`panel_event_definitions`: description, hidden, verified).
 */

import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelEventDefinition } from '@weldsuite/db/schema';
import type { PanelLexiconDto, PanelLexiconEntry, UpdatePanelLexiconInput } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { createRunner, runLexiconScan, type PanelQueryContext, type PanelSqlExecutor } from '@weldsuite/panel-domain/query';

const { panelEventDefinitions } = schema;

export const LEXICON_CACHE_SECONDS = 3600;

interface CachedScan {
  events: { name: string; count: number }[];
  properties: string[];
  scannedAt: string;
}

export function lexiconCacheKey(workspaceId: string, projectId: string): string {
  return `panel:lexicon:${workspaceId}:${projectId}`;
}

/** The names seen, from KV when fresh, else from Basin. A broken cache costs a scan, never the request. */
export async function loadNamesSeen(
  kv: Pick<KVNamespace, 'get' | 'put'>,
  ctx: PanelQueryContext,
  execute: () => PanelSqlExecutor,
): Promise<CachedScan> {
  const key = lexiconCacheKey(ctx.workspaceId, ctx.projectId);
  try {
    const cached = await kv.get(key, 'json');
    if (cached && typeof cached === 'object') return cached as CachedScan;
  } catch (error) {
    console.warn('[panel-api] lexicon cache read failed', error);
  }
  const scan = await runLexiconScan(ctx, createRunner(execute()).run);
  try {
    await kv.put(key, JSON.stringify(scan), { expirationTtl: LEXICON_CACHE_SECONDS });
  } catch (error) {
    console.warn('[panel-api] lexicon cache write failed', error);
  }
  return scan;
}

export async function listDefinitions(db: Database, projectId: string): Promise<PanelEventDefinition[]> {
  return db.select().from(panelEventDefinitions).where(eq(panelEventDefinitions.projectId, projectId)).orderBy(asc(panelEventDefinitions.name));
}

function entry(name: string, seen: boolean, count: number | null, def: PanelEventDefinition | undefined): PanelLexiconEntry {
  return {
    name,
    seen,
    count30d: count,
    description: def?.description ?? null,
    hidden: def?.hidden ?? false,
    verified: def?.verified ?? false,
    definitionId: def?.id ?? null,
  };
}

/** Names seen, then definitions of names not seen (a verified event can be quiet for a month). */
export function mergeLexicon(scan: CachedScan, defs: PanelEventDefinition[]): PanelLexiconDto {
  const byKey = new Map(defs.map((d) => [`${d.kind}:${d.name}`, d]));
  const events = scan.events.map((e) => entry(e.name, true, e.count, byKey.get(`event:${e.name}`)));
  const properties = scan.properties.map((name) => entry(name, true, null, byKey.get(`property:${name}`)));
  const seenEvents = new Set(scan.events.map((e) => e.name));
  const seenProps = new Set(scan.properties);
  for (const d of defs) {
    if (d.kind === 'event' && !seenEvents.has(d.name)) events.push(entry(d.name, false, null, d));
    if (d.kind === 'property' && !seenProps.has(d.name)) properties.push(entry(d.name, false, null, d));
  }
  return { events, properties, scannedAt: scan.scannedAt };
}

export interface DefinitionResult {
  definition: PanelEventDefinition;
  created: boolean;
}

/** Creates or changes a definition; only the fields given change. */
export async function upsertDefinition(db: Database, userId: string, input: UpdatePanelLexiconInput): Promise<DefinitionResult> {
  const set = {
    ...(input.description !== undefined && { description: input.description }),
    ...(input.hidden !== undefined && { hidden: input.hidden }),
    ...(input.verified !== undefined && { verified: input.verified }),
    updatedByUserId: userId,
    updatedAt: new Date(),
  };
  const [existing] = await db
    .select({ id: panelEventDefinitions.id })
    .from(panelEventDefinitions)
    .where(and(eq(panelEventDefinitions.projectId, input.projectId), eq(panelEventDefinitions.kind, input.kind), eq(panelEventDefinitions.name, input.name)))
    .limit(1);
  const [row] = await db
    .insert(panelEventDefinitions)
    .values({
      id: generateId('pne'),
      projectId: input.projectId,
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      hidden: input.hidden ?? false,
      verified: input.verified ?? false,
      updatedByUserId: userId,
    })
    .onConflictDoUpdate({
      target: [panelEventDefinitions.projectId, panelEventDefinitions.kind, panelEventDefinitions.name],
      set,
    })
    .returning();
  return { definition: row as PanelEventDefinition, created: !existing };
}

export function definitionEventData(d: PanelEventDefinition) {
  return { id: d.id, projectId: d.projectId, kind: d.kind, name: d.name, hidden: d.hidden, verified: d.verified };
}

export function definitionToEntry(d: PanelEventDefinition, scan: CachedScan | null): PanelLexiconEntry {
  const list = d.kind === 'event' ? scan?.events.map((e) => e.name) : scan?.properties;
  const count = d.kind === 'event' ? (scan?.events.find((e) => e.name === d.name)?.count ?? null) : null;
  return entry(d.name, !!list?.includes(d.name), count, d);
}

