/**
 * Per-entity access for the WeldHR routes (weldsuite-documentation/plans/legal-entities.md,
 * "Per-entity access"). `legalEntityContext` (index.ts) resolves the request's
 * entity and swaps in the member's entity role; this file turns that into the
 * two things the routes need:
 *
 *   - list scoping: a condition on the employee's (or employer's) legal entity
 *     that the services add to their filters. Without an `X-Legal-Entity-Id`
 *     header a member sees the entities where they act with their workspace
 *     role, never one where an entity role applies (`requestEntityScope`);
 *   - by-id checks: a record of an entity the request may not touch answers
 *     404, not 403, so a restricted entity's records are never confirmed.
 *
 * A record's entity is its employee's `legal_entity_id` (employer's for
 * payroll setup); a row without one counts as the default entity's.
 */

import { eq, type AnyColumn, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Context, MiddlewareHandler } from 'hono';
import {
  canSeeEntity,
  defaultEntityIdFor,
  entityScopeCondition,
  getEntityAccess,
  recordInRequestEntity,
  requestEntityScope,
  requestedEntityId,
} from '@weldsuite/core-domain/legal-entities';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { error } from '@weldsuite/worker-kit/response';
import { employeeIdIn, employerIdIn } from '../../services/weldhr/entity-scope';
import { HrNotFoundError, HrValidationError } from '../../services/weldhr/shared';
import { db, type HrContext } from './helpers';

interface Scope {
  /** Entity ids the request may list, or null for no filter. */
  entities: string[] | null;
  defaultEntityId: string | null;
}

const scopes = new WeakMap<Context, Promise<Scope>>();

function scopeOf(c: HrContext): Promise<Scope> {
  let pending = scopes.get(c);
  if (!pending) {
    pending = (async () => {
      const entities = await requestEntityScope(c);
      // The default only matters when a filter applies (rows without an entity count as its).
      const defaultEntityId = entities === null ? null : await defaultEntityIdFor(db(c), 'weldhr');
      return { entities, defaultEntityId };
    })();
    scopes.set(c, pending);
  }
  return pending;
}

/** Condition on `hr_employees.legal_entity_id` for this request; undefined = no filter. */
export async function employeeEntityCondition(c: HrContext): Promise<SQL | undefined> {
  const { entities, defaultEntityId } = await scopeOf(c);
  return entityScopeCondition(schema.hrEmployees.legalEntityId, entities, defaultEntityId);
}

/** Condition on `hr_payroll_employers.legal_entity_id` for this request; undefined = no filter. */
export async function employerEntityCondition(c: HrContext): Promise<SQL | undefined> {
  const { entities, defaultEntityId } = await scopeOf(c);
  return entityScopeCondition(schema.hrPayrollEmployers.legalEntityId, entities, defaultEntityId);
}

/** The request's scope applied to a table through its employee column. */
export async function scopeByEmployee(c: HrContext, employeeColumn: AnyColumn): Promise<SQL | undefined> {
  return employeeIdIn(employeeColumn, await employeeEntityCondition(c));
}

/** The request's scope applied to a table through its employer column. */
export async function scopeByEmployer(c: HrContext, employerColumn: AnyColumn): Promise<SQL | undefined> {
  return employerIdIn(employerColumn, await employerEntityCondition(c));
}

/** May this request touch a record of `entityId`? A row without an entity counts as the default entity's. */
export async function entityAllowed(c: HrContext, entityId: string | null): Promise<boolean> {
  const effective = entityId ?? (await defaultEntityIdFor(db(c), 'weldhr'));
  return recordInRequestEntity(c, effective);
}

/** Throw a 404 unless the employee exists in an entity this request may touch. A missing employee is left to the caller. */
export async function assertEmployeeVisible(c: HrContext, employeeId: string | null | undefined): Promise<void> {
  if (!employeeId) return;
  const [row] = await db(c)
    .select({ entityId: schema.hrEmployees.legalEntityId })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, employeeId))
    .limit(1);
  if (row && !(await entityAllowed(c, row.entityId))) throw new HrNotFoundError('Employee', employeeId);
}

/**
 * A legal entity this request may put a record in: it exists, the member sees it and
 * acts there with the role the request was checked with. Anything else is a 404 (a
 * restricted entity's existence is never confirmed).
 */
export async function assertEntityUsable(c: HrContext, entityId: string): Promise<void> {
  if (!(await entityUsable(c, entityId))) throw new HrNotFoundError('Legal entity', entityId);
}

async function entityUsable(c: HrContext, entityId: string): Promise<boolean> {
  const access = await getEntityAccess(c);
  return canSeeEntity(access, entityId) && (await recordInRequestEntity(c, entityId));
}

/**
 * The entity a new employee belongs to, in order: the entity of the request
 * (`X-Legal-Entity-Id`), else the one the body names, else the workspace default,
 * else none (a workspace without entities). A request that names an entity it
 * may not use (unknown, hidden, not WeldHR's) is a `Legal entity` 404, never the
 * body's or the default; the body's and the default must pass the same check as
 * `assertEntityUsable`. A refused default is a 404 without its id: the caller
 * never named it, and may not even see it.
 */
export async function resolveNewEmployeeEntity(c: HrContext, requested: string | null | undefined): Promise<string | null> {
  const fromRequest = c.get('legalEntityId') ?? null;
  if (fromRequest) {
    if (requested && requested !== fromRequest) {
      throw new HrValidationError('legalEntityId is not the legal entity this request is scoped to');
    }
    return fromRequest;
  }
  const named = requestedEntityId(c);
  if (named) throw new HrNotFoundError('Legal entity', named);
  if (requested) {
    await assertEntityUsable(c, requested);
    return requested;
  }
  const fallback = await defaultEntityIdFor(db(c), 'weldhr');
  if (fallback && !(await entityUsable(c, fallback))) {
    throw new HrNotFoundError('Legal entity', fallback, 'Legal entity not found');
  }
  return fallback;
}

/** Same for a payroll employer. */
export async function assertEmployerVisible(c: HrContext, employerId: string | null | undefined): Promise<void> {
  if (!employerId) return;
  const [row] = await db(c)
    .select({ entityId: schema.hrPayrollEmployers.legalEntityId })
    .from(schema.hrPayrollEmployers)
    .where(eq(schema.hrPayrollEmployers.id, employerId))
    .limit(1);
  if (row && !(await entityAllowed(c, row.entityId))) throw new HrNotFoundError('Payroll employer', employerId);
}

// ---------------------------------------------------------------------------
// By-id guards
// ---------------------------------------------------------------------------

/** What a guard needs of a record: its entity (null = the default's), or null when no such record exists. */
export type RecordEntity = { entityId: string | null } | null;
export type RecordResolver = (database: Database, id: string) => Promise<RecordEntity>;

/** A record keyed by its employee's entity: `idColumn` finds the row, `employeeColumn` names the employee. */
export function viaEmployee(table: PgTable, idColumn: AnyColumn, employeeColumn: AnyColumn): RecordResolver {
  return async (database, id) => {
    const [row] = await database
      .select({ entityId: schema.hrEmployees.legalEntityId })
      .from(table)
      .innerJoin(schema.hrEmployees, eq(schema.hrEmployees.id, employeeColumn))
      .where(eq(idColumn, id))
      .limit(1);
    return row ? { entityId: row.entityId } : null;
  };
}

/** A record keyed by its employer's entity. */
export function viaEmployer(table: PgTable, idColumn: AnyColumn, employerColumn: AnyColumn): RecordResolver {
  return async (database, id) => {
    const [row] = await database
      .select({ entityId: schema.hrPayrollEmployers.legalEntityId })
      .from(table)
      .innerJoin(schema.hrPayrollEmployers, eq(schema.hrPayrollEmployers.id, employerColumn))
      .where(eq(idColumn, id))
      .limit(1);
    return row ? { entityId: row.entityId } : null;
  };
}

/** An employee by id. */
export const employeeRecord: RecordResolver = async (database, id) => {
  const [row] = await database
    .select({ entityId: schema.hrEmployees.legalEntityId })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, id))
    .limit(1);
  return row ? { entityId: row.entityId } : null;
};

/** An employer by id. */
export const employerRecord: RecordResolver = async (database, id) => {
  const [row] = await database
    .select({ entityId: schema.hrPayrollEmployers.legalEntityId })
    .from(schema.hrPayrollEmployers)
    .where(eq(schema.hrPayrollEmployers.id, id))
    .limit(1);
  return row ? { entityId: row.entityId } : null;
};

/**
 * Answer 404 for `/:<param>` and `/:<param>/*` when the record belongs to an
 * entity the request may not touch. An id that matches no record (a literal
 * segment like `/summary`, or a real miss) passes through to the route, which
 * answers its own 404. Register before the routes it guards. `prefix` guards
 * `<prefix>/:<param>` instead (checklist tasks live under `/tasks/:taskId`).
 */
export function guardRecord(
  router: { use: (path: string, ...handlers: MiddlewareHandler[]) => unknown },
  param: string,
  resource: string,
  resolve: RecordResolver,
  prefix = '',
): void {
  const guard: MiddlewareHandler = async (c, next) => {
    const id = c.req.param(param);
    if (id) {
      const record = await resolve(c.get('tenantDb') as Database, id);
      if (record && !(await entityAllowed(c as HrContext, record.entityId))) return error.notFound(c, resource, id);
    }
    return next();
  };
  router.use(`${prefix}/:${param}`, guard);
  router.use(`${prefix}/:${param}/*`, guard);
}
