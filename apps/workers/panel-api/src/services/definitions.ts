/**
 * Data definitions of a project: custom events (several events under one
 * name), computed properties (a value derived from event properties) and path
 * rules (path cleaning). Query specs refer to the first two as `@<id>`; the
 * query engine loads them (and the path rules) into the query context.
 *
 * Names of custom events and computed properties are unique per project
 * (ignoring case). A formula is checked with the shared expression parser
 * (`@weldsuite/panel-domain/expression`), the one the query compiler uses.
 */

import { and, asc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import type { PanelComputedProperty, PanelCustomEvent, PanelPathRule } from '@weldsuite/db/schema';
import { parseExpression } from '@weldsuite/panel-domain/expression';
import {
  panelComputedPropertyDefinitionSchema,
  panelCustomEventDefinitionSchema,
  type CreatePanelComputedPropertyInput,
  type CreatePanelCustomEventInput,
  type PanelComputedPropertyDefinition,
  type PanelComputedPropertyDto,
  type PanelCustomEventDefinition,
  type PanelCustomEventDto,
  type PanelPathRuleDto,
  type PanelPathRuleInput,
  type UpdatePanelComputedPropertyInput,
  type UpdatePanelCustomEventInput,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';

const { panelComputedProperties, panelCustomEvents, panelPathRules } = schema;

/** Definitions listed per project. */
export const MAX_LISTED_DEFINITIONS = 500;

/** A request the definition cannot be saved for: 400 (bad definition) or 409 (name taken). */
export class DefinitionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Custom events
// ---------------------------------------------------------------------------

export function toCustomEventDto(row: PanelCustomEvent): PanelCustomEventDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    definition: panelCustomEventDefinitionSchema.parse(row.definition),
    ref: `@${row.id}`,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_custom_event` event: never the definition. */
export function customEventEventData(row: PanelCustomEvent) {
  return { id: row.id, projectId: row.projectId, name: row.name };
}

export async function listCustomEvents(db: Database, projectId: string): Promise<PanelCustomEvent[]> {
  return db
    .select()
    .from(panelCustomEvents)
    .where(and(eq(panelCustomEvents.projectId, projectId), isNull(panelCustomEvents.deletedAt)))
    .orderBy(asc(panelCustomEvents.name))
    .limit(MAX_LISTED_DEFINITIONS);
}

export async function getCustomEvent(db: Database, id: string): Promise<PanelCustomEvent | null> {
  const [row] = await db.select().from(panelCustomEvents).where(and(eq(panelCustomEvents.id, id), isNull(panelCustomEvents.deletedAt))).limit(1);
  return row ?? null;
}

/** The computed properties (`@pncp_…`) a definition's filters name. */
function computedRefsOf(definition: PanelCustomEventDefinition): string[] {
  const refs = new Set<string>();
  for (const match of definition.match) {
    for (const filter of match.filters ?? []) {
      if ('key' in filter && typeof filter.key === 'string' && filter.key.startsWith('@')) refs.add(filter.key.slice(1));
    }
  }
  return [...refs];
}

async function checkCustomEvent(db: Database, projectId: string, input: { name?: string; definition?: PanelCustomEventDefinition }, selfId?: string): Promise<void> {
  if (input.name !== undefined) await checkNameFree(db, panelCustomEvents, projectId, input.name, selfId);
  if (input.definition) {
    const refs = computedRefsOf(input.definition);
    if (refs.length > 0) {
      const found = await db
        .select({ id: panelComputedProperties.id })
        .from(panelComputedProperties)
        .where(and(inArray(panelComputedProperties.id, refs), eq(panelComputedProperties.projectId, projectId), isNull(panelComputedProperties.deletedAt)));
      const known = new Set(found.map((r) => r.id));
      const missing = refs.filter((id) => !known.has(id));
      if (missing.length > 0) throw new DefinitionError(`Unknown computed property: @${missing[0]}`, 400);
    }
  }
}

export async function createCustomEvent(db: Database, input: CreatePanelCustomEventInput, userId: string): Promise<PanelCustomEvent> {
  await checkCustomEvent(db, input.projectId, input);
  const [row] = await db
    .insert(panelCustomEvents)
    .values({
      id: generateId('pnce'),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      definition: panelCustomEventDefinitionSchema.parse(input.definition) as unknown as Record<string, unknown>,
      ownerUserId: userId,
    })
    .returning();
  return row as PanelCustomEvent;
}

export async function updateCustomEvent(db: Database, existing: PanelCustomEvent, input: UpdatePanelCustomEventInput): Promise<PanelCustomEvent | null> {
  await checkCustomEvent(db, existing.projectId, input, existing.id);
  const [row] = await db
    .update(panelCustomEvents)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.definition !== undefined && {
        definition: panelCustomEventDefinitionSchema.parse(input.definition) as unknown as Record<string, unknown>,
      }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelCustomEvents.id, existing.id), isNull(panelCustomEvents.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteCustomEvent(db: Database, id: string): Promise<PanelCustomEvent | null> {
  const [row] = await db
    .update(panelCustomEvents)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelCustomEvents.id, id), isNull(panelCustomEvents.deletedAt)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Computed properties
// ---------------------------------------------------------------------------

export function toComputedPropertyDto(row: PanelComputedProperty): PanelComputedPropertyDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    definition: panelComputedPropertyDefinitionSchema.parse(row.definition),
    ref: `@${row.id}`,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_computed_property` event: never the definition. */
export function computedPropertyEventData(row: PanelComputedProperty) {
  return { id: row.id, projectId: row.projectId, name: row.name };
}

export async function listComputedProperties(db: Database, projectId: string): Promise<PanelComputedProperty[]> {
  return db
    .select()
    .from(panelComputedProperties)
    .where(and(eq(panelComputedProperties.projectId, projectId), isNull(panelComputedProperties.deletedAt)))
    .orderBy(asc(panelComputedProperties.name))
    .limit(MAX_LISTED_DEFINITIONS);
}

export async function getComputedProperty(db: Database, id: string): Promise<PanelComputedProperty | null> {
  const [row] = await db
    .select()
    .from(panelComputedProperties)
    .where(and(eq(panelComputedProperties.id, id), isNull(panelComputedProperties.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Throws a 400 {@link DefinitionError} for a formula the expression parser refuses. */
export function checkComputedDefinition(definition: PanelComputedPropertyDefinition): void {
  if (definition.kind !== 'formula') return;
  const parsed = parseExpression(definition.expression, { identifiers: 'properties' });
  if (!parsed.ok) throw new DefinitionError(parsed.error.message, 400, { position: parsed.error.position });
  if (parsed.identifiers.length === 0) throw new DefinitionError('Use at least one property in the formula', 400, { position: 0 });
}

export async function createComputedProperty(db: Database, input: CreatePanelComputedPropertyInput, userId: string): Promise<PanelComputedProperty> {
  checkComputedDefinition(input.definition);
  await checkNameFree(db, panelComputedProperties, input.projectId, input.name);
  const [row] = await db
    .insert(panelComputedProperties)
    .values({
      id: generateId('pncp'),
      projectId: input.projectId,
      name: input.name,
      description: input.description ?? null,
      definition: panelComputedPropertyDefinitionSchema.parse(input.definition) as unknown as Record<string, unknown>,
      ownerUserId: userId,
    })
    .returning();
  return row as PanelComputedProperty;
}

export async function updateComputedProperty(
  db: Database,
  existing: PanelComputedProperty,
  input: UpdatePanelComputedPropertyInput,
): Promise<PanelComputedProperty | null> {
  if (input.definition) checkComputedDefinition(input.definition);
  if (input.name !== undefined) await checkNameFree(db, panelComputedProperties, existing.projectId, input.name, existing.id);
  const [row] = await db
    .update(panelComputedProperties)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.definition !== undefined && {
        definition: panelComputedPropertyDefinitionSchema.parse(input.definition) as unknown as Record<string, unknown>,
      }),
      updatedAt: new Date(),
    })
    .where(and(eq(panelComputedProperties.id, existing.id), isNull(panelComputedProperties.deletedAt)))
    .returning();
  return row ?? null;
}

export async function deleteComputedProperty(db: Database, id: string): Promise<PanelComputedProperty | null> {
  const [row] = await db
    .update(panelComputedProperties)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(panelComputedProperties.id, id), isNull(panelComputedProperties.deletedAt)))
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Shared: unique names
// ---------------------------------------------------------------------------

type NamedTable = typeof panelCustomEvents | typeof panelComputedProperties;

/** Throws a 409 {@link DefinitionError} when another live definition of the project has this name. */
async function checkNameFree(db: Database, table: NamedTable, projectId: string, name: string, selfId?: string): Promise<void> {
  const conds: SQL[] = [eq(table.projectId, projectId), isNull(table.deletedAt), sql`lower(${table.name}) = lower(${name})`];
  if (selfId) conds.push(ne(table.id, selfId));
  const [taken] = await db.select({ id: table.id }).from(table).where(and(...conds)).limit(1);
  if (taken) throw new DefinitionError(`"${name}" is already taken in this project`, 409);
}

// ---------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------

export function toPathRuleDto(row: PanelPathRule): PanelPathRuleDto {
  return {
    id: row.id,
    projectId: row.projectId,
    position: row.position,
    pattern: row.pattern,
    replacement: row.replacement,
    description: row.description,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The payload of a `panel_path_rule` event (the catalog's: id, project, position, pattern, replacement). */
export function pathRuleEventData(row: PanelPathRule) {
  return { id: row.id, projectId: row.projectId, position: row.position, pattern: row.pattern, replacement: row.replacement };
}

export async function listPathRules(db: Database, projectId: string): Promise<PanelPathRule[]> {
  return db
    .select()
    .from(panelPathRules)
    .where(eq(panelPathRules.projectId, projectId))
    .orderBy(asc(panelPathRules.position), asc(panelPathRules.id));
}

/** What replacing a project's rules does to each position. */
export interface PathRulesPlan {
  created: number;
  updated: number;
  deleted: number;
}

/** How many rules a replacement creates, changes and deletes (compared by position). */
export function planPathRules(existing: readonly PanelPathRule[], rules: readonly PanelPathRuleInput[]): PathRulesPlan {
  let updated = 0;
  for (let i = 0; i < Math.min(existing.length, rules.length); i += 1) {
    const before = existing[i] as PanelPathRule;
    const after = rules[i] as PanelPathRuleInput;
    if (before.pattern !== after.pattern || before.replacement !== after.replacement || before.description !== (after.description ?? null)) updated += 1;
  }
  return { created: Math.max(rules.length - existing.length, 0), updated, deleted: Math.max(existing.length - rules.length, 0) };
}

export interface PathRulesChange {
  rules: PanelPathRule[];
  created: PanelPathRule[];
  updated: PanelPathRule[];
  deleted: PanelPathRule[];
}

/**
 * Replaces the project's rules with `rules`, in that order, in one
 * transaction. Rules are matched by position: a changed one keeps its id and
 * is `updated`, extra ones are `created`, missing ones `deleted`.
 */
export async function replacePathRules(
  db: Database,
  projectId: string,
  rules: readonly PanelPathRuleInput[],
  existing: readonly PanelPathRule[],
  userId: string,
): Promise<PathRulesChange> {
  const now = new Date();
  const updatedIds: string[] = [];
  const createdIds: string[] = [];
  const deleted = existing.slice(rules.length);

  const results = await atomically(db, (handle) => {
    const statements: unknown[] = [];
    rules.forEach((rule, position) => {
      const before = existing[position];
      const description = rule.description ?? null;
      if (!before) {
        const id = generateId('pnpr');
        createdIds.push(id);
        statements.push(
          handle.insert(panelPathRules).values({ id, projectId, position, pattern: rule.pattern, replacement: rule.replacement, description, createdByUserId: userId }),
        );
        return;
      }
      if (before.pattern === rule.pattern && before.replacement === rule.replacement && before.description === description && before.position === position) return;
      updatedIds.push(before.id);
      statements.push(
        handle
          .update(panelPathRules)
          .set({ position, pattern: rule.pattern, replacement: rule.replacement, description, updatedAt: now })
          .where(and(eq(panelPathRules.id, before.id), eq(panelPathRules.projectId, projectId))),
      );
    });
    if (deleted.length > 0) {
      statements.push(handle.delete(panelPathRules).where(and(eq(panelPathRules.projectId, projectId), inArray(panelPathRules.id, deleted.map((r) => r.id)))));
    }
    statements.push(handle.select().from(panelPathRules).where(eq(panelPathRules.projectId, projectId)).orderBy(asc(panelPathRules.position), asc(panelPathRules.id)));
    return statements;
  });

  const after = results[results.length - 1] as PanelPathRule[];
  return {
    rules: after,
    created: after.filter((r) => createdIds.includes(r.id)),
    updated: after.filter((r) => updatedIds.includes(r.id)),
    deleted,
  };
}
