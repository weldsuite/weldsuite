/**
 * Request helpers of the reporting routes (`/api/project-status-reports` and
 * `/api/project-stakeholders`): the JSON body and the query string read with a
 * Zod schema, answered the way every WeldFlow control route answers a bad one
 * (`Invalid JSON body`, `Invalid request body` / `Invalid query parameters`
 * with the issues as `{ path, message }`).
 */

import type { Context } from 'hono';
import type { z } from 'zod';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../types';

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

function details(issues: z.ZodIssue[]) {
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
  if (!parsed.success) {
    return { ok: false, response: error.badRequest(c, 'Invalid request body', details(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}

/** The query string without empty values (`?status=` means no filter), parsed with a Zod schema. */
export function readQuery<S extends z.ZodTypeAny>(c: AppContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', details(parsed.error.issues)) };
  }
  return { ok: true, data: parsed.data };
}
