/**
 * Read-only routes for WeldBooks resources on the public API.
 *
 * The ledger changes only through books-api: that is where tax is calculated,
 * documents are numbered and posted to the journal, lock dates and fiscal
 * periods are enforced, entities are seeded with a chart of accounts and every
 * change lands in the accounting audit log. A generic insert/update straight
 * into the accounting tables skips all of it, so the public API serves these
 * resources for reading only. Anything that writes answers 405.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { error, list, success, cursorPagination } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { columnsFor } from '../../../lib/select-columns';

/** HTTP methods that would change a resource. */
export const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Methods a read-only resource answers (HEAD rides on GET; OPTIONS is CORS). */
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

/**
 * 405 for a write on a read-only resource, in the worker's standard error
 * envelope. `noun` is the plural resource name, e.g. `invoices`.
 */
export function methodNotAllowed(c: Context, noun: string) {
  c.header('Allow', ALLOWED_METHODS);
  return c.json(
    {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `The ${noun} resource is read-only through the public API. Create and change ${noun} in WeldBooks.`,
      },
    },
    405,
  );
}

/**
 * Handler that answers every write method with 405. Runs after authentication
 * (the `/v1/*` middleware), and still returns 401 when there is no session, so
 * the answer is the same whatever scopes the key holds.
 */
export function rejectWrites(noun: string): MiddlewareHandler<HonoEnv> {
  return async (c) => {
    if (!c.get('apiSession')) return error.unauthorized(c);
    return methodNotAllowed(c, noun);
  };
}

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  entityId: z.string().optional(),
});

interface ReadableTable {
  id: { name: string };
  createdAt: { name: string };
  deletedAt?: { name: string };
  entityId?: { name: string };
}

export interface ReadOnlyRouteOptions<TTable extends ReadableTable> {
  table: TTable;
  /** Scope namespace, e.g. `invoices` gives `invoices:read`. */
  scope: string;
  /** Singular label for the 404 message, e.g. `Invoice`. */
  label: string;
  /** Plural noun for the 405 message, e.g. `invoices`. */
  noun: string;
  /**
   * Column property names to leave out of every response, on top of the
   * ciphertext columns the table is already known to hold. Never selected, so
   * never read from the database either.
   */
  omit?: readonly string[];
}

/**
 * List + get for one accounting table, with the same scope check, cursor
 * pagination, `entityId` filter and soft-delete handling the generic CRUD
 * factory uses, and 405 on every write.
 */
export function createReadOnlyRoute<TTable extends ReadableTable>(
  opts: ReadOnlyRouteOptions<TTable>,
): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  const table = opts.table;
  // Drizzle table typing is erased here, same approach as lib/crud-route.ts.
  const tbl = table as any;
  const readScope = `${opts.scope}:read`;
  const columns = columnsFor(table, opts.omit) as any;

  app.get('/', requireScope(readScope), zValidator('query', listQuery), async (c) => {
    const db = c.get('tenantDb');
    const q = c.req.valid('query');
    const where: (SQL | undefined)[] = [];
    if (q.entityId && table.entityId) {
      where.push(eq(tbl.entityId, q.entityId));
    }
    const result = await listWithCursor({
      db,
      table,
      where,
      cursor: q.cursor,
      limit: q.limit,
      omit: opts.omit,
    });
    return list(
      c,
      result.data as Record<string, unknown>[],
      cursorPagination(result.totalCount, result.hasMore, result.cursor),
    );
  });

  app.get('/:id', requireScope(readScope), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const conditions: SQL[] = [eq(tbl.id, id)];
    if (table.deletedAt) {
      conditions.push(isNull(tbl.deletedAt));
    }
    const [row] = await db.select(columns).from(tbl).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, opts.label, id);
    return success(c, row);
  });

  app.on([...WRITE_METHODS], '/*', rejectWrites(opts.noun));

  return app;
}
