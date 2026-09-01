/**
 * Factory for standard external-api CRUD routes (list/get/create/update/delete).
 *
 * Mirrors the pattern in routes like companies/ and products/ so new entity
 * surfaces stay thin and consistent.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z, type ZodTypeAny } from 'zod';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { publishEntityEvent, type EntityType } from '@weldsuite/entity-events';
import type { HonoEnv } from '../types';
import { requireScope } from './scopes';
import { generateId } from './id';
import { error, list, noContent, success, cursorPagination } from './response';
import { listWithCursor } from './list-helpers';

const defaultListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
  entityId: z.string().optional(),
});

interface ListableTable {
  id: { name: string };
  createdAt: { name: string };
  deletedAt?: { name: string };
  entityId?: { name: string };
}

export interface CrudRouteOptions<TTable extends ListableTable> {
  table: TTable;
  /** Scope namespace, e.g. `invoices` → `invoices:read`. */
  scope: string;
  /** Human label for error messages, e.g. `Invoice`. */
  label: string;
  idPrefix: string;
  entityType: EntityType;
  createSchema: ZodTypeAny;
  updateSchema: ZodTypeAny;
  listQuery?: ZodTypeAny;
  /** Extra WHERE filters from the validated list query. */
  filters?: (query: Record<string, unknown>) => (SQL | undefined)[];
  /** Transform the validated create body before insert. */
  prepareCreate?: (body: Record<string, unknown>) => Record<string, unknown>;
  /** Transform the validated update body before update. */
  prepareUpdate?: (
    body: Record<string, unknown>,
    existing: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Payload forwarded to publishEntityEvent. */
  eventData?: (row: Record<string, unknown>) => Record<string, unknown>;
  softDelete?: boolean;
  /** When false, mutations skip publishEntityEvent (e.g. types not in the catalog). */
  publishEvents?: boolean;
}

export function createCrudRoute<TTable extends ListableTable>(
  opts: CrudRouteOptions<TTable>,
): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  const table = opts.table;
  // Drizzle table typing is erased here — same approach as list-helpers.ts.
  const tbl = table as any;
  const listQuerySchema = opts.listQuery ?? defaultListQuery;
  const softDelete = opts.softDelete ?? true;
  const publishEvents = opts.publishEvents ?? true;
  const readScope = `${opts.scope}:read`;
  const writeScope = `${opts.scope}:write`;

  app.get('/', requireScope(readScope), zValidator('query', listQuerySchema), async (c) => {
    const db = c.get('tenantDb');
    const q = c.req.valid('query') as Record<string, unknown>;
    const where: (SQL | undefined)[] = opts.filters?.(q) ?? [];
    if (q.entityId && table.entityId) {
      where.push(eq(tbl.entityId, q.entityId as string));
    }
    const result = await listWithCursor({
      db,
      table,
      where,
      cursor: q.cursor as string | undefined,
      limit: q.limit as number | undefined,
      softDelete,
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
    if (softDelete && table.deletedAt) {
      conditions.push(isNull(tbl.deletedAt));
    }
    const [row] = await db.select().from(tbl).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, opts.label, id);
    return success(c, row);
  });

  app.post('/', requireScope(writeScope), zValidator('json', opts.createSchema), async (c) => {
    const db = c.get('tenantDb');
    const body = c.req.valid('json') as Record<string, unknown>;
    const now = new Date();
    const id = generateId(opts.idPrefix);
    const values = {
      id,
      createdAt: now,
      updatedAt: now,
      ...(opts.prepareCreate?.(body) ?? body),
    };
    const inserted = (await db.insert(tbl).values(values).returning()) as Record<string, unknown>[];
    const row = inserted[0];
    if (!row) return error.internal(c, `Failed to create ${opts.label.toLowerCase()}`);
    if (publishEvents) {
      const data = opts.eventData?.(row as Record<string, unknown>) ?? { id };
      publishEntityEvent({
        c,
        entityType: opts.entityType,
        entityId: id,
        action: 'created',
        data,
      });
    }
    return success(c, row, 201);
  });

  app.patch('/:id', requireScope(writeScope), zValidator('json', opts.updateSchema), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const body = c.req.valid('json') as Record<string, unknown>;
    const conditions: SQL[] = [eq(tbl.id, id)];
    if (softDelete && table.deletedAt) {
      conditions.push(isNull(tbl.deletedAt));
    }
    const [existing] = await db.select().from(tbl).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, opts.label, id);
    const update = {
      ...(opts.prepareUpdate?.(body, existing as Record<string, unknown>) ?? body),
      updatedAt: new Date(),
    };
    const updated = (await db.update(tbl).set(update).where(and(...conditions)).returning()) as Record<
      string,
      unknown
    >[];
    const row = updated[0];
    if (!row) return error.internal(c, `Failed to update ${opts.label.toLowerCase()}`);
    if (publishEvents) {
      const data = opts.eventData?.(row as Record<string, unknown>) ?? { id };
      publishEntityEvent({
        c,
        entityType: opts.entityType,
        entityId: id,
        action: 'updated',
        data,
      });
    }
    return success(c, row);
  });

  app.delete('/:id', requireScope(writeScope), async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const conditions: SQL[] = [eq(tbl.id, id)];
    if (softDelete && table.deletedAt) {
      conditions.push(isNull(tbl.deletedAt));
    }
    const deleted = (
      softDelete && table.deletedAt
        ? await db
            .update(tbl)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(and(...conditions))
            .returning()
        : await db.delete(tbl).where(and(...conditions)).returning()
    ) as Record<string, unknown>[];
    const row = deleted[0];
    if (!row) return error.notFound(c, opts.label, id);
    if (publishEvents) {
      publishEntityEvent({
        c,
        entityType: opts.entityType,
        entityId: id,
        action: 'deleted',
        data: { id },
      });
    }
    return noContent(c);
  });

  return app;
}
