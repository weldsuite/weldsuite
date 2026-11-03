/**
 * Request helpers shared by the governance routes (`/api/project-decisions`,
 * `/api/project-deliverables`, `/api/project-scope`, `/api/project-benefits`):
 * the JSON body parsed with a Zod schema, the query string without empty
 * values, and the messages of the project access refusals.
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../types';

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export const PROJECT_DENIED = 'You are not a member of this project';
export const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
export const PROJECT_MANAGE_DENIED = 'You do not have manage access to this project';

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

function issuesOf(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** The JSON body parsed with a Zod schema: a 400 with the issues otherwise. */
export async function parseBody<S extends z.ZodTypeAny>(c: AppContext, bodySchema: S): Promise<Parsed<z.infer<S>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: error.badRequest(c, 'Invalid JSON body') };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, response: error.badRequest(c, 'Invalid request body', issuesOf(parsed.error.issues)) };
  return { ok: true, data: parsed.data };
}

/** The query string without empty values (`?projectId=` means no filter), parsed with a Zod schema. */
export function readQuery<S extends z.ZodTypeAny>(c: AppContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', issuesOf(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}

/** An ISO timestamp from a request body, or null. */
export function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** A number as the numeric column stores it (text), or null. */
export function numeric(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}
