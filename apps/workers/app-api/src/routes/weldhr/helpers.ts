/**
 * Shared plumbing for the WeldHR routes.
 */

import type { Context } from 'hono';
import { publishEntityEvent, type ActionFor, type DataFor, type EntityType } from '@weldsuite/entity-events';
import { error } from '../../lib/response';
import type { Database } from '../../db';
import type { Env, Variables } from '../../types';
import { ensureDefaultTemplates } from '../../services/weldhr/lifecycle';
import { ensureDefaultEvaluationForm, ensureDefaultKpis } from '../../services/weldhr/performance';
import { HrConflictError, HrNotFoundError, HrValidationError } from '../../services/weldhr/shared';
import { ensureDefaultLeaveTypes } from '../../services/weldhr/time';

export type HrContext = Context<{ Bindings: Env; Variables: Variables }>;

export function db(c: HrContext): Database {
  return c.get('tenantDb');
}

export function actor(c: HrContext): string {
  return c.get('userId');
}

export function clientIp(c: HrContext): string | null {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || null;
}

/** Path parameter the route is known to declare; fails loudly if a route is renamed. */
export function param(c: HrContext, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`WeldHR route is missing the :${name} parameter`);
  return value;
}

type HrEntity = Extract<EntityType, `hr_${string}`>;

/**
 * Publish a WeldHR entity event. Every catalog topic reaches every workspace
 * member over the WorkspaceHub, so the payload is ids and status only — never
 * names, notes, scores or sensitive fields.
 */
export function emit<T extends HrEntity>(
  c: HrContext,
  entityType: T,
  action: ActionFor<T>,
  entityId: string,
  data: { employeeId?: string | null; status?: string | null; companyId?: string | null } = {},
) {
  publishEntityEvent({
    c,
    entityType,
    action,
    entityId,
    // hr_* types have no curated payload interface, so DataFor<T> is a plain record.
    data: { id: entityId, ...data } as DataFor<T>,
  });
}

/** Map service errors onto the standard envelope; `null` for anything else. */
export function toHrErrorResponse(err: unknown, c: HrContext): Response | null {
  if (err instanceof HrNotFoundError) return error.notFound(c, err.resource, err.id);
  if (err instanceof HrValidationError) return error.badRequest(c, err.message, err.details);
  if (err instanceof HrConflictError) return error.conflict(c, err.message);
  return null;
}

/**
 * First request per workspace per isolate seeds the starter templates, leave
 * types, scorecard and KPIs. Each `ensure*` is a single `limit 1` probe once
 * seeded, and the memo keeps even that off the hot path.
 */
const seeded = new Set<string>();

export async function ensureHrDefaults(c: HrContext) {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId || seeded.has(workspaceId)) return;
  const database = db(c);
  await Promise.all([
    ensureDefaultTemplates(database),
    ensureDefaultLeaveTypes(database),
    ensureDefaultEvaluationForm(database),
    ensureDefaultKpis(database),
  ]);
  seeded.add(workspaceId);
}
