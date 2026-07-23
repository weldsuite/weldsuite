/**
 * Accounting export routes — flat /api/accounting-exports/* surface.
 *
 * GET /xaf?fiscalYear=YYYY — XAF 4.0 auditfile (Auditfile Financieel) for the
 * resolved entity's fiscal year. Produced on demand for a Belastingdienst
 * boekenonderzoek or accountant handoff; XAF 4.0 is mandatory since 1 Jan 2026.
 *
 * Permissions: reports:read.
 */

import { Hono } from 'hono';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import type { Env, Variables } from '../../types';
import { error } from '../../lib/response';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '../../services/accounting-guards';
import {
  generateXaf,
  type XafTransaction,
} from '../../services/accounting-xaf';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/xaf', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const fiscalYear = parseInt(c.req.query('fiscalYear') || '', 10);
  if (!fiscalYear || fiscalYear < 2000 || fiscalYear > 2100) {
    return error.badRequest(c, 'fiscalYear query parameter is required (e.g. ?fiscalYear=2026)');
  }

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const [entity] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entity) return error.notFound(c, 'Entity', entityId);

    // Fiscal year window from the entity's fiscal year start month
    const startMonth = (entity.fiscalYearStart ?? 1) - 1;
    const start = new Date(Date.UTC(fiscalYear, startMonth, 1));
    const end = new Date(Date.UTC(fiscalYear + 1, startMonth, 1));
    end.setUTCDate(end.getUTCDate() - 1);
    const startDate = start.toISOString().slice(0, 10);
    const endDate = end.toISOString().slice(0, 10);

    const [accounts, contacts, taxRates, entries] = await Promise.all([
      db.select().from(schema.accounts)
        .where(and(eq(schema.accounts.entityId, entityId), isNull(schema.accounts.deletedAt)))
        .orderBy(asc(schema.accounts.code)),
      db.select().from(schema.parties).where(isNull(schema.parties.deletedAt)),
      db.select().from(schema.taxRates)
        .where(and(eq(schema.taxRates.entityId, entityId), isNull(schema.taxRates.deletedAt))),
      db.select().from(schema.journalEntries)
        .where(and(
          eq(schema.journalEntries.entityId, entityId),
          eq(schema.journalEntries.status, 'posted'),
          isNull(schema.journalEntries.deletedAt),
          gte(schema.journalEntries.date, start),
          lte(schema.journalEntries.date, end),
        ))
        .orderBy(asc(schema.journalEntries.date)),
    ]);

    // Lines for all entries in the window (chunked IN() to stay under limits)
    const accountCodeById = new Map(accounts.map((a) => [a.id, a.code]));
    const transactions: XafTransaction[] = [];
    for (const entry of entries) {
      const lines = await db.select().from(schema.journalLines)
        .where(and(
          eq(schema.journalLines.journalEntryId, entry.id),
          isNull(schema.journalLines.deletedAt),
        ))
        .orderBy(asc(schema.journalLines.sortOrder));
      transactions.push({
        entryNumber: entry.entryNumber ?? entry.id,
        date: entry.date.toISOString().slice(0, 10),
        description: entry.description,
        sourceType: entry.sourceType,
        lines: lines.map((line) => ({
          accountCode: accountCodeById.get(line.accountId) ?? line.accountId,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
          contactId: line.contactId,
          vatCodeId: line.taxRateId,
          vatAmount: line.taxAmount,
        })),
      });
    }

    const xml = generateXaf({
      entity,
      fiscalYear,
      startDate,
      endDate,
      accounts: accounts.map((a) => ({
        code: a.code,
        name: a.name,
        type: a.type,
        openingBalance: a.openingBalance,
      })),
      contacts: contacts.map((p) => ({
        id: p.id,
        name: p.displayName ?? p.id,
        role: p.role,
        taxNumber: null,
      })),
      vatCodes: taxRates.map((t) => ({ id: t.id, name: t.name, rate: t.rate })),
      transactions,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'accounting_export',
      entityId: `xaf-${fiscalYear}`,
      action: 'exported',
    });

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="auditfile-${fiscalYear}-${entity.name.replace(/[^a-zA-Z0-9-]/g, '_')}.xaf"`,
      },
    });
  } catch (err) {
    console.error('[app-api/accounting-exports] xaf failed:', err);
    return error.internal(c, 'Failed to generate XAF auditfile');
  }
});

export const accountingExportsRoutes = app;
