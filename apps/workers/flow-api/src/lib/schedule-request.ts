/**
 * Request parsing of the scheduling routes (`/api/task-dependencies`,
 * `/api/project-schedule`, `/api/project-phases`): the JSON body against a Zod
 * schema, and the query string without empty values. A failure is the 400 the
 * Rust backend answers alike (`Invalid request body` / `Invalid query
 * parameters`, with the Zod issues as `{ path, message }` details).
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../types';

export type ScheduleContext = Context<{ Bindings: Env; Variables: Variables }>;

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

function issuesOf(issues: z.ZodIssue[]) {
  return issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/** The JSON body parsed with a Zod schema: a 400 with the issues otherwise. */
export async function parseBody<S extends z.ZodTypeAny>(c: ScheduleContext, bodySchema: S): Promise<Parsed<z.infer<S>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: error.badRequest(c, 'Invalid JSON body') };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, response: error.badRequest(c, 'Invalid request body', issuesOf(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}

/** The query string without empty values (`?projectId=` means no filter), parsed with a Zod schema. */
export function readQuery<S extends z.ZodTypeAny>(c: ScheduleContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', issuesOf(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}

export const PROJECT_DENIED = 'You are not a member of this project';
export const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
export const PROJECT_MANAGE_DENIED = 'You do not have manage access to this project';
