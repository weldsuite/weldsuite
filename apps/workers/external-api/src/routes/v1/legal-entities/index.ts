/**
 * Legal entities on the public API: `GET /v1/legal-entities` and
 * `GET /v1/legal-entities/:id`, scope `legal_entities:read`. Read-only.
 *
 * The companies of the workspace (docs/plans/legal-entities.md) with their
 * registrations and bank accounts. Bank accounts carry no account number at
 * all, and the IBAN is masked to its last four characters. Per-entity access
 * (restricted entities) is a platform member concept: API keys have no entity
 * allow-list yet, so a key sees every entity.
 *
 * Creating and changing entities happens in the platform (Settings > Legal
 * entities); every write here answers 405. `/v1/accounting-entities` is the
 * WeldBooks view of the same table and is unchanged.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { HonoEnv } from '../../../types';
import { requireScope } from '../../../lib/scopes';
import { cursorPagination, error, list, success } from '../../../lib/response';
import { listWithCursor } from '../../../lib/list-helpers';
import { WRITE_METHODS } from '../accounting/read-only-route';
import { columnsFor } from '../../../lib/select-columns';
import { schema, type Database } from '../../../db';

const READ_SCOPE = 'legal_entities:read';

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).optional(),
});

type EntityRow = typeof schema.legalEntities.$inferSelect;

/** `****************4300`: the IBAN with everything but the last four characters hidden. */
export function maskIban(iban: string | null | undefined): string | null {
  if (!iban) return null;
  const compact = iban.replaceAll(/\s/g, '');
  return compact.length <= 4 ? compact : '*'.repeat(compact.length - 4) + compact.slice(-4);
}

interface PublicRegistration {
  id: string;
  type: string;
  number: string;
  country: string | null;
  region: string | null;
  label: string | null;
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
}

interface PublicBankAccount {
  id: string;
  name: string;
  accountHolderName: string | null;
  ibanMasked: string | null;
  bic: string | null;
  bankName: string | null;
  currency: string | null;
  accountType: string | null;
  isDefault: boolean;
  isActive: boolean;
}

/** Registrations and bank accounts of these entities, keyed by entity id. */
async function loadChildren(db: Database, ids: string[]) {
  const registrations = new Map<string, PublicRegistration[]>();
  const bankAccounts = new Map<string, PublicBankAccount[]>();
  if (ids.length === 0) return { registrations, bankAccounts };

  const regs = await db
    .select()
    .from(schema.legalEntityRegistrations)
    .where(and(inArray(schema.legalEntityRegistrations.entityId, ids), isNull(schema.legalEntityRegistrations.deletedAt)))
    .orderBy(asc(schema.legalEntityRegistrations.createdAt));
  for (const r of regs) {
    const rows = registrations.get(r.entityId) ?? [];
    rows.push({
      id: r.id,
      type: r.type,
      number: r.number,
      country: r.country ?? null,
      region: r.region ?? null,
      label: r.label ?? null,
      validFrom: r.validFrom ?? null,
      validTo: r.validTo ?? null,
      isPrimary: r.isPrimary,
    });
    registrations.set(r.entityId, rows);
  }

  // Explicit columns: the account number (encrypted or not) is never selected.
  const b = schema.bankAccounts;
  const banks = await db
    .select({
      id: b.id,
      entityId: b.entityId,
      name: b.name,
      accountHolderName: b.accountHolderName,
      iban: b.iban,
      bic: b.bic,
      bankName: b.bankName,
      currency: b.currency,
      accountType: b.accountType,
      isDefault: b.isDefault,
      isActive: b.isActive,
    })
    .from(b)
    .where(and(inArray(b.entityId, ids), isNull(b.deletedAt)))
    .orderBy(asc(b.createdAt));
  for (const r of banks) {
    const rows = bankAccounts.get(r.entityId) ?? [];
    rows.push({
      id: r.id,
      name: r.name,
      accountHolderName: r.accountHolderName ?? null,
      ibanMasked: maskIban(r.iban),
      bic: r.bic ?? null,
      bankName: r.bankName ?? null,
      currency: r.currency ?? null,
      accountType: r.accountType ?? null,
      isDefault: Boolean(r.isDefault),
      isActive: r.isActive !== false,
    });
    bankAccounts.set(r.entityId, rows);
  }
  return { registrations, bankAccounts };
}

function toPublic(
  row: EntityRow,
  children: { registrations: Map<string, PublicRegistration[]>; bankAccounts: Map<string, PublicBankAccount[]> },
) {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName ?? null,
    tradingName: row.dba ?? null,
    legalForm: row.entityType ?? null,
    jurisdictionCode: row.jurisdictionCode,
    baseCurrency: row.baseCurrency,
    locale: row.locale,
    timezone: row.timezone ?? null,
    address: row.address ?? null,
    contact: row.contact ?? null,
    branding: row.branding
      ? { logoUrl: row.branding.logoUrl, primaryColor: row.branding.primaryColor, accentColor: row.branding.accentColor }
      : null,
    fiscalYearStart: row.fiscalYearStart ?? null,
    isDefault: Boolean(row.isDefault),
    isActive: row.isActive !== false,
    registrations: children.registrations.get(row.id) ?? [],
    bankAccounts: children.bankAccounts.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const app = new Hono<HonoEnv>();

app.get('/', requireScope(READ_SCOPE), zValidator('query', listQuery), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.valid('query');
  const result = await listWithCursor<typeof schema.legalEntities, EntityRow>({
    db,
    table: schema.legalEntities,
    cursor: q.cursor,
    limit: q.limit,
  });
  const rows = result.data as EntityRow[];
  const children = await loadChildren(db, rows.map((r) => r.id));
  return list(c, rows.map((r) => toPublic(r, children)), cursorPagination(result.totalCount, result.hasMore, result.cursor));
});

app.get('/:id', requireScope(READ_SCOPE), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select(columnsFor(schema.legalEntities) as never)
    .from(schema.legalEntities)
    .where(and(eq(schema.legalEntities.id, id), isNull(schema.legalEntities.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Legal entity', id);
  const entity = row as unknown as EntityRow;
  return success(c, toPublic(entity, await loadChildren(db, [entity.id])));
});

// Writes belong in the platform. Still 401 without a session, like the other read-only resources.
app.on([...WRITE_METHODS], '/*', (c) => {
  if (!c.get('apiSession')) return error.unauthorized(c);
  c.header('Allow', 'GET, HEAD, OPTIONS');
  return c.json(
    {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'The legal entities resource is read-only through the public API. Create and change legal entities in WeldSuite (Settings > Legal entities).',
      },
    },
    405,
  );
});

export default app;
