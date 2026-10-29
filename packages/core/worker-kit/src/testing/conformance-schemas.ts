/**
 * The Zod response schema of each route the Rust backend serves, for
 * conformance mode (./conformance.ts): every successful Rust response is
 * validated against it, so a shape the clients can't parse fails even where a
 * test's assertions don't look.
 *
 * Keyed by method and the Hono route pattern (`/api/companies/:id`). Register
 * a route here when its module is ported (playbook step 5). Schemas come from
 * the client packages, which is what the platform and the mobile apps parse
 * responses with.
 */

import { myPermissionsSchema } from '@weldsuite/app-api-client/schemas/me';

/** The parts of a Zod schema this file needs, so worker-kit doesn't depend on zod. */
interface ResponseSchema {
  safeParse(value: unknown): { success: true } | { success: false; error: { message: string } };
}

type Envelope = 'single' | 'list';

interface RouteSchema {
  method: string;
  route: string;
  /** `{ data: T }` or `{ data: T[], pagination }`. */
  envelope: Envelope;
  data: ResponseSchema;
}

const ROUTES: RouteSchema[] = [
  { method: 'GET', route: '/api/me/permissions', envelope: 'single', data: myPermissionsSchema },
];

/** null when valid, else why not. */
type Validator = (body: unknown) => string | null;

function validate(entry: RouteSchema, body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('data' in body)) return 'no `data` in the response envelope';
  const data = (body as { data: unknown }).data;
  if (entry.envelope === 'list') {
    if (!Array.isArray(data)) return '`data` is not an array';
    const pagination = (body as { pagination?: unknown }).pagination as Record<string, unknown> | undefined;
    if (
      !pagination ||
      typeof pagination.totalCount !== 'number' ||
      typeof pagination.hasMore !== 'boolean' ||
      !(typeof pagination.cursor === 'string' || pagination.cursor === null)
    ) {
      return '`pagination` is not { totalCount, hasMore, cursor }';
    }
    for (const [i, item] of data.entries()) {
      const result = entry.data.safeParse(item);
      if (!result.success) return `data[${i}]: ${result.error.message}`;
    }
    return null;
  }
  const result = entry.data.safeParse(data);
  return result.success ? null : result.error.message;
}

/** The validator registered for a route, if any. */
export function schemaFor(method: string, route: string): Validator | undefined {
  const entry = ROUTES.find((r) => r.method === method && r.route === route);
  return entry ? (body) => validate(entry, body) : undefined;
}

/** Every registered route, for the coverage report. */
export function registeredRoutes(): ReadonlyArray<{ method: string; route: string }> {
  return ROUTES.map(({ method, route }) => ({ method, route }));
}
