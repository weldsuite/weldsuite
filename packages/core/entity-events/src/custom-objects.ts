/**
 * WeldObjects — entity events for user-defined custom objects.
 *
 * Custom objects are defined at RUNTIME by a workspace admin, so their entity
 * types cannot exist in the compile-time `ENTITY_EVENTS` catalog the way
 * `customer` or `ticket` do. This module is the single, deliberate escape
 * hatch that lets them publish anyway.
 *
 * ## Why not just add one catalog entry?
 *
 * The obvious fix — register a single `custom_object_record` entity type and
 * carry the object slug inside `data` — is wrong. `triggerMatchesEvent` in
 * workflow-dispatch.ts compares entity types with strict equality:
 *
 *     if (tEntityType !== entityType) return false;
 *
 * so every custom object would collapse onto one shared trigger and a workflow
 * could never fire for "Machine created" without also firing for "Certification
 * created". The object identity has to live in the entity type itself.
 *
 * ## The design
 *
 * Each custom object gets an entity key `co_<slug>`, and that string is what
 * goes on the wire: `co_machine:created`. Every downstream sink — audit queue,
 * analytics queue, search queue, realtime DO, outbound webhooks, workflow
 * dispatch — treats `entityType` as an opaque string, so all of them work
 * unmodified. The ONLY thing standing in the way is the TypeScript signature of
 * `publishEntityEvent`, and this module absorbs that with one documented cast
 * in one place instead of a cast at every call site.
 *
 * Callers must pass a key that has already been resolved from the tenant's
 * `custom_objects` table. `assertCustomObjectEntityKey` is a shape check, not
 * an existence check — it stops a malformed key reaching the wire, but it is
 * the caller's job not to invent objects.
 *
 * ## Key length budget
 *
 * `search_index.entity_type` is `varchar(30)`, which is the tightest column any
 * entity key has to fit. `co_` + a 24-character slug = 27, leaving headroom.
 * That is where CUSTOM_OBJECT_SLUG_MAX_LENGTH comes from — it is a storage
 * constraint, not a style preference, so do not raise it without widening the
 * column across every tenant database first.
 */

import type { Context } from 'hono';
import {
  publishEntityEvent,
  publishEntityEventRaw,
  type EntityEventPublisherEnv,
  type EntityEventPublisherVariables,
} from './publisher';
import type { EntityType } from './events';
import type { EventSource } from './types';
import type { TenantDb } from './internal-types';

// ---------------------------------------------------------------------------
// Entity key format
// ---------------------------------------------------------------------------

/** Prefix distinguishing a custom object entity type from every built-in one. */
export const CUSTOM_OBJECT_ENTITY_KEY_PREFIX = 'co_';

/**
 * Longest permitted object slug. Derived from `search_index.entity_type`
 * being varchar(30): 30 - len('co_') = 27, and we hold back 3 characters so a
 * future prefix change doesn't require a data migration.
 */
export const CUSTOM_OBJECT_SLUG_MAX_LENGTH = 24;

/** Slug shape: starts with a letter, then lowercase alphanumerics/underscores. */
export const CUSTOM_OBJECT_SLUG_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

const ENTITY_KEY_PATTERN = /^co_[a-z][a-z0-9_]{0,23}$/;

/**
 * Actions a custom object record can emit. Deliberately the three physical
 * CRUD actions and nothing else — derived actions (won/paid/resolved) are a
 * property of first-party domain logic, and a user-defined object has none.
 */
export const CUSTOM_OBJECT_ACTIONS = ['created', 'updated', 'deleted'] as const;
export type CustomObjectAction = (typeof CUSTOM_OBJECT_ACTIONS)[number];

/** `'machine'` → `'co_machine'`. */
export function customObjectEntityKey(slug: string): string {
  return `${CUSTOM_OBJECT_ENTITY_KEY_PREFIX}${slug}`;
}

/** `'co_machine'` → `'machine'`; null when the value isn't a custom object key. */
export function customObjectSlugFromEntityKey(entityKey: string): string | null {
  if (!ENTITY_KEY_PATTERN.test(entityKey)) return null;
  return entityKey.slice(CUSTOM_OBJECT_ENTITY_KEY_PREFIX.length);
}

/** Shape check only — says nothing about whether the object exists. */
export function isCustomObjectEntityKey(entityKey: string): boolean {
  return ENTITY_KEY_PATTERN.test(entityKey);
}

function assertCustomObjectEntityKey(entityKey: string): void {
  if (!ENTITY_KEY_PATTERN.test(entityKey)) {
    throw new Error(
      `[EntityEvents] '${entityKey}' is not a valid custom object entity key. ` +
        `Expected 'co_<slug>' with a slug of at most ${CUSTOM_OBJECT_SLUG_MAX_LENGTH} characters.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Publishers
// ---------------------------------------------------------------------------

/**
 * Hono's `Context` is invariant in its Bindings and brands `HonoRequest` with a
 * non-unique symbol per path literal, so a concrete route context
 * (`Context<{Bindings: Env}, "/:slug/records">`) is not assignable to the
 * generic `Context<{Bindings: EntityEventPublisherEnv}>` the publisher declares
 * — and a shared helper that forwards `c` hits this immediately.
 *
 * The same widening the permissions middleware uses (`LooseContext`/`RouteSlot`
 * in @weldsuite/permissions/server) applies here. Confining it to this module
 * is the point: callers keep their fully-typed context, and exactly one file
 * knows about the variance.
 */
type LooseHonoContext = Context<any, any, any>;

export interface PublishCustomObjectEventParams<
  B extends EntityEventPublisherEnv = EntityEventPublisherEnv,
  V extends EntityEventPublisherVariables = EntityEventPublisherVariables,
> {
  c: Context<{ Bindings: B; Variables: V }> | LooseHonoContext;
  /** `co_<slug>`, resolved from the tenant's `custom_objects` table. */
  entityKey: string;
  action: CustomObjectAction;
  /** The `custom_object_records.id` (cor_…). */
  entityId: string;
  /**
   * Record payload. Convention is the thin record row merged with its
   * hydrated custom field values, so workflow conditions and webhook consumers
   * can read user-defined fields by slug without a second fetch.
   */
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  accessUserIds?: string[];
  source?: EventSource;
}

/**
 * Fire-and-forget publisher for a custom object record mutation.
 *
 * Mirrors `publishEntityEvent` exactly — same fan-out, same `waitUntil`
 * semantics, same never-blocks-the-response guarantee. The wire event is
 * `co_<slug>:<action>`.
 */
export function publishCustomObjectEvent<
  B extends EntityEventPublisherEnv = EntityEventPublisherEnv,
  V extends EntityEventPublisherVariables = EntityEventPublisherVariables,
>(params: PublishCustomObjectEventParams<B, V>): void {
  const { entityKey, ...rest } = params;
  assertCustomObjectEntityKey(entityKey);

  publishEntityEvent({
    ...rest,
    // THE cast. `EntityType` is a compile-time union of first-party entity
    // names; a custom object's key is only knowable at runtime. Everything
    // downstream of here treats entityType as an opaque string (see the module
    // docblock), so this is safe — and confining it to this one line is the
    // entire reason this module exists.
    entityType: entityKey as EntityType,
  } as unknown as Parameters<typeof publishEntityEvent>[0]);
}

export interface PublishCustomObjectEventRawParams {
  env: EntityEventPublisherEnv;
  db: TenantDb;
  workspaceId: string;
  userId: string;
  entityKey: string;
  action: CustomObjectAction;
  entityId: string;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  accessUserIds?: string[];
  source?: EventSource;
}

/**
 * Context-free variant, for queue consumers and Workflow steps that mutate
 * custom object records without a Hono context. Awaits every sink.
 */
export async function publishCustomObjectEventRaw(
  params: PublishCustomObjectEventRawParams,
): Promise<void> {
  const { entityKey, ...rest } = params;
  assertCustomObjectEntityKey(entityKey);

  await publishEntityEventRaw({
    ...rest,
    entityType: entityKey as EntityType,
  });
}

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

/**
 * Every subscribable event for one custom object, in the dotted form used by
 * agent `eventSubscriptions` and the workflow trigger picker.
 * `'machine'` → `['co_machine.created', 'co_machine.updated', 'co_machine.deleted']`.
 */
export function listCustomObjectEvents(slug: string): string[] {
  const key = customObjectEntityKey(slug);
  return CUSTOM_OBJECT_ACTIONS.map((action) => `${key}.${action}`);
}

/**
 * Build the runtime entity-type set to hand to `parseEventName`,
 * `isKnownEntityType` and `isValidSubscription` as their `extraEntityTypes`
 * argument, so tenant-defined objects validate alongside the static catalog.
 */
export function customObjectEntityTypes(slugs: readonly string[]): Set<string> {
  return new Set(slugs.map(customObjectEntityKey));
}
