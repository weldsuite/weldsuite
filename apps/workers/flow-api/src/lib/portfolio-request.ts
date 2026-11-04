/**
 * Request helpers of the portfolio routes (`/api/capacity`,
 * `/api/project-requests`): the JSON body and the query string read with a Zod
 * schema, answering a 400 the same way the RAID routes do (`Invalid request
 * body` / `Invalid query parameters`, the issues as `details`).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { error } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../types';

export type PortfolioContext = Context<{ Bindings: Env; Variables: Variables }>;

export type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** The JSON body parsed with a Zod schema: a 400 with the issues otherwise. */
export async function parseBody<S extends z.ZodTypeAny>(c: PortfolioContext, bodySchema: S): Promise<Parsed<z.infer<S>>> {
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

/** The query string without empty values (`?from=` means no filter), parsed with a Zod schema. */
export function readQuery<S extends z.ZodTypeAny>(c: PortfolioContext, querySchema: S): Parsed<z.infer<S>> {
  const raw = Object.fromEntries(Object.entries(c.req.query()).filter(([, value]) => value !== ''));
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    return { ok: false, response: error.badRequest(c, 'Invalid query parameters', details) };
  }
  return { ok: true, data: parsed.data };
}

/** Today as `YYYY-MM-DD` (UTC). */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `true` / `1` is on, `false` / `0` off, anything else (left out) is off. */
export function flag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}
