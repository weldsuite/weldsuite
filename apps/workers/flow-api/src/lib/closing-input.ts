/**
 * Request input of the closing routes (`/api/project-lessons`,
 * `/api/project-close`, `/api/project-templates`): the JSON body and the query
 * string read with a Zod schema, answered as the project-control routes answer
 * them (`Invalid JSON body`, `Invalid request body` / `Invalid query
 * parameters` with the issues as `details`).
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../types';

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** The JSON body parsed with a Zod schema: a 400 with the issues otherwise. */
export async function parseBody<S extends z.ZodTypeAny>(c: AppContext, bodySchema: S): Promise<Parsed<z.infer<S>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: error.badRequest(c, 'Invalid JSON body') };
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid request body', details) };
  }
  return { ok: true, data: parsed.data };
}

/** The query string without empty values (`?projectId=` means no filter), parsed with a Zod schema. */
export function readQuery<S extends z.ZodTypeAny>(c: AppContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', details) };
  }
  return { ok: true, data: parsed.data };
}

export const PROJECT_DENIED = 'You are not a member of this project';
export const PROJECT_WRITE_DENIED = 'You do not have write access to this project';
export const PROJECT_MANAGE_DENIED = 'You must be a project owner, admin, or manager to close this project';
