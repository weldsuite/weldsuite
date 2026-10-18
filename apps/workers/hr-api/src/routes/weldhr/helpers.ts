/**
 * Shared plumbing for the WeldHR routes.
 */

import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { ZodIssue, ZodSchema } from 'zod';
import { publishEntityEvent, type ActionFor, type DataFor, type EntityType } from '@weldsuite/entity-events';
import { error } from '@weldsuite/worker-kit/response';
import type { Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { ensureDefaultTemplates } from '../../services/weldhr/lifecycle';
import { ensureDefaultEvaluationForm, ensureDefaultKpis } from '../../services/weldhr/performance';
import { notifyPortal } from '../../services/weldhr/portal-realtime';
import { HrConflictError, HrNotFoundError, HrPayrollError, HrValidationError } from '../../services/weldhr/shared';
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

/** The R2 bucket declaration receipts live in. A missing binding is a deploy error, not a client one. */
export function receiptBucket(c: HrContext): R2Bucket {
  if (!c.env.STORAGE) throw new Error('hr-api is missing its STORAGE (R2) binding');
  return c.env.STORAGE;
}

/** The tenant the request was authenticated into; the auth chain always sets it. */
export function workspaceIdOf(c: HrContext): string {
  const workspaceId = c.get('workspaceId');
  if (!workspaceId) throw new Error('WeldHR route reached without a workspace');
  return workspaceId;
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
 *
 * The same change is signalled to the workforce portal (the employee's own
 * topic and the client accounts they work on), so an approval in the back
 * office shows up in the portal without a reload.
 */
export function emit<T extends HrEntity>(
  c: HrContext,
  entityType: T,
  action: ActionFor<T>,
  entityId: string,
  data: { employeeId?: string | null; status?: string | null; companyId?: string | null } = {},
  /** Narrow who hears about it in the portal — see PortalSignal.portal / .client. */
  audience: { portal?: boolean; client?: boolean } = {},
) {
  publishEntityEvent({
    c,
    entityType,
    action,
    entityId,
    // hr_* types have no curated payload interface, so DataFor<T> is a plain record.
    data: { id: entityId, ...data } as DataFor<T>,
  });
  notifyPortal(c, {
    entity: entityType,
    action,
    id: entityId,
    employeeId: data.employeeId ?? (entityType === 'hr_employee' ? entityId : null),
    companyId: data.companyId ?? null,
    ...audience,
  });
}

/** A workspace-wide portal change (branding, feature switches, leave types). */
export function emitPortalConfig(c: HrContext, entity: string, id: string) {
  notifyPortal(c, { entity, action: 'updated', id, workspaceWide: true });
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** `breakMinutes` → "Break minutes"; array indexes become "row 2" (1-based). */
function fieldLabel(path: ReadonlyArray<string | number>): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (typeof segment === 'number') {
      parts.push(`#${segment + 1}`);
      continue;
    }
    const words = segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    parts.push(words);
  }
  const label = parts.join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** One readable sentence per Zod issue, instead of Zod's "Number must be greater than or equal to 0". */
export function describeIssue(issue: ZodIssue): string {
  const field = issue.path.length ? fieldLabel(issue.path) : 'Value';
  switch (issue.code) {
    case 'too_small':
      if (issue.type === 'string') return Number(issue.minimum) <= 1 ? `${field} is required` : `${field} needs at least ${issue.minimum} characters`;
      if (issue.type === 'array') return `${field} needs at least ${issue.minimum} item(s)`;
      return `${field} must be ${issue.inclusive ? 'at least' : 'more than'} ${issue.minimum}`;
    case 'too_big':
      if (issue.type === 'string') return `${field} can be at most ${issue.maximum} characters`;
      if (issue.type === 'array') return `${field} can have at most ${issue.maximum} item(s)`;
      return `${field} must be ${issue.inclusive ? 'at most' : 'less than'} ${issue.maximum}`;
    case 'invalid_type':
      return issue.received === 'undefined' ? `${field} is required` : `${field} has the wrong type`;
    case 'invalid_string':
      if (issue.validation === 'email') return `${field} must be a valid email address`;
      if (issue.validation === 'url') return `${field} must be a valid URL`;
      if (issue.validation === 'datetime') return `${field} must be a date and time`;
      return `${field}: ${issue.message}`;
    case 'invalid_enum_value':
      return `${field} must be one of ${issue.options.join(', ')}`;
    default:
      return `${field}: ${issue.message}`;
  }
}

/**
 * JSON body validator for the WeldHR routes. A failed body answers with the
 * standard error envelope and readable messages, not the serialized ZodError
 * the default `zValidator` hook sends; the raw issues stay in `details`.
 */
export function hrJson<T extends ZodSchema>(schema: T) {
  return zValidator('json', schema, (result, c) => {
    if (result.success) return undefined;
    const messages = [...new Set(result.error.issues.map(describeIssue))];
    return c.json({ error: { code: 'BAD_REQUEST', message: messages.join('. '), details: result.error.issues } }, 400);
  });
}

/** Map service errors onto the standard envelope; `null` for anything else. */
export function toHrErrorResponse(err: unknown, c: HrContext): Response | null {
  if (err instanceof HrNotFoundError) {
    if (err.userMessage) return c.json({ error: { code: 'NOT_FOUND', message: err.userMessage } }, 404);
    return error.notFound(c, err.resource, err.id);
  }
  if (err instanceof HrValidationError) return error.badRequest(c, err.message, err.details);
  if (err instanceof HrConflictError) return error.conflict(c, err.message);
  if (err instanceof HrPayrollError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
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
