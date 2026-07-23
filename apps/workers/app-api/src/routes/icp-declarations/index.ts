/**
 * Opgaaf ICP routes — flat /api/icp-declarations/* surface.
 *
 * The ICP declaration is legally required alongside the BTW-aangifte whenever
 * the entity had 0%-rated intracommunautaire B2B supplies (rubriek 3b) in the
 * period: a per-customer listing of buyer VAT number, country and net amount.
 * Calculation aggregates posted journal lines carrying the intracommunautaire
 * tax rate, grouped by the buyer's VIES VAT number; filing goes through the
 * same Digipoort channel as the VAT return.
 *
 * Permissions: reports:read | reports:create | reports:update.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import { resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '../../services/accounting-guards';
import { getContactVatNumber } from '../../services/accounting-compliance';
import { normalizeVatNumber } from '../../services/vies';
import { generateIcpXml, type IcpXmlLine } from '../../services/accounting-icp-xml';
import { submitFiling, createConfig } from '../../services/accounting-digipoort';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /
app.get('/', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const results = await db
      .select()
      .from(schema.icpDeclarations)
      .where(and(isNull(schema.icpDeclarations.deletedAt), eq(schema.icpDeclarations.entityId, entityId)))
      .orderBy(desc(schema.icpDeclarations.periodStart));
    return success(c, results);
  } catch (err) {
    console.error('[app-api/icp-declarations] list failed:', err);
    return error.internal(c, 'Failed to fetch ICP declarations');
  }
});

// GET /:id — declaration + lines
app.get('/:id', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [declaration] = await db.select().from(schema.icpDeclarations)
      .where(and(eq(schema.icpDeclarations.id, id), isNull(schema.icpDeclarations.deletedAt))).limit(1);
    if (!declaration) return error.notFound(c, 'ICP declaration', id);
    const lines = await db.select().from(schema.icpLines)
      .where(eq(schema.icpLines.declarationId, id))
      .orderBy(asc(schema.icpLines.vatNumber));
    return success(c, { ...declaration, lines });
  } catch (err) {
    console.error('[app-api/icp-declarations] get failed:', err);
    return error.internal(c, 'Failed to fetch ICP declaration');
  }
});

// POST /calculate — aggregate intracommunautaire supplies per customer
app.post('/calculate', requirePermission('reports:create'), zValidator('json', z.object({
  periodType: z.enum(['monthly', 'quarterly', 'yearly']),
  periodStart: z.string(),
  periodEnd: z.string(),
  periodLabel: z.string().optional(),
})), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');

    const { journalLines, journalEntries, taxRates } = schema;
    const periodStart = new Date(data.periodStart);
    const periodEnd = new Date(data.periodEnd);

    // Tax rates that represent intracommunautaire supplies (rubriek 3b).
    const icpRateIds = new Set<string>();
    const allRates = await db.select().from(taxRates).where(isNull(taxRates.deletedAt));
    for (const rate of allRates) {
      const rubriek = (rate.jurisdictionMetadata as { btwRubriek?: string } | null)?.btwRubriek;
      if (rubriek === '3b' && rate.type !== 'purchase') icpRateIds.add(rate.id);
    }

    // Posted, non-reversal journal lines in the period on ICP rates.
    const lines = await db
      .select({
        debit: journalLines.debit,
        credit: journalLines.credit,
        taxRateId: journalLines.taxRateId,
        contactId: journalLines.contactId,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.journalEntryId, journalEntries.id))
      .where(and(
        isNull(journalLines.deletedAt),
        eq(journalEntries.entityId, entityId),
        eq(journalEntries.status, 'posted'),
        isNull(journalEntries.reversalOfId),
        gte(journalEntries.date, periodStart),
        lte(journalEntries.date, periodEnd),
      ));

    // Group net supply amounts per buyer VAT number. The single seeded
    // intracommunautaire rate covers goods and services alike — WeldBooks
    // doesn't capture product type per line yet, so everything reports as
    // 'services' (matching the eu_b2b_service category). Splitting goods vs
    // services needs product-type capture on invoice lines (follow-up).
    const perVat = new Map<string, { countryCode: string; contactId: string | null; amount: number }>();
    const missingVat: string[] = [];

    for (const line of lines) {
      if (!line.taxRateId || !icpRateIds.has(line.taxRateId)) continue;
      const amount = Math.abs(parseFloat(line.credit || '0') - parseFloat(line.debit || '0'));
      if (amount === 0) continue;

      const rawVat = await getContactVatNumber(db, line.contactId);
      const normalized = rawVat ? normalizeVatNumber(rawVat) : null;
      if (!normalized) {
        if (line.contactId && !missingVat.includes(line.contactId)) missingVat.push(line.contactId);
        continue;
      }

      const existing = perVat.get(normalized.full);
      if (existing) {
        existing.amount += amount;
      } else {
        perVat.set(normalized.full, {
          countryCode: normalized.countryCode,
          contactId: line.contactId,
          amount,
        });
      }
    }

    const now = new Date();
    const declarationId = generateId('icp');
    const totalAmount = [...perVat.values()].reduce((sum, v) => sum + v.amount, 0);

    await db.insert(schema.icpDeclarations).values({
      id: declarationId,
      entityId,
      periodType: data.periodType,
      periodStart,
      periodEnd,
      periodLabel: data.periodLabel || null,
      status: 'calculated',
      totalAmount: totalAmount.toFixed(2),
      notes: missingVat.length > 0
        ? `Supplies for ${missingVat.length} contact(s) were skipped because no VAT number is on their company record: ${missingVat.join(', ')}`
        : null,
      createdAt: now,
      updatedAt: now,
    });

    if (perVat.size > 0) {
      await db.insert(schema.icpLines).values(
        [...perVat.entries()].map(([vatNumber, entry]) => ({
          id: generateId('icpl'),
          declarationId,
          entityId,
          contactId: entry.contactId,
          vatNumber,
          countryCode: entry.countryCode,
          supplyType: 'services',
          amount: entry.amount.toFixed(2),
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'icp_declaration',
      entityId: declarationId,
      action: 'calculated',
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: declarationId, action: 'created', data: { id: declarationId, kind: 'icp', totalAmount } });

    return success(c, {
      id: declarationId,
      totalAmount,
      lineCount: perVat.size,
      skippedContacts: missingVat,
    }, 201);
  } catch (err) {
    console.error('[app-api/icp-declarations] calculate failed:', err);
    return error.internal(c, 'Failed to calculate ICP declaration');
  }
});

// POST /:id/file — generate ICP XBRL and submit via Digipoort
app.post('/:id/file', requirePermission('reports:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');

  try {
    const [declaration] = await db.select().from(schema.icpDeclarations)
      .where(and(eq(schema.icpDeclarations.id, id), isNull(schema.icpDeclarations.deletedAt))).limit(1);
    if (!declaration) return error.notFound(c, 'ICP declaration', id);
    if (declaration.status === 'filed' || declaration.status === 'accepted') {
      return error.badRequest(c, 'ICP declaration has already been filed');
    }

    const lines = await db.select().from(schema.icpLines)
      .where(eq(schema.icpLines.declarationId, id));
    if (lines.length === 0) {
      return error.badRequest(c, 'ICP declaration has no lines — nothing to file (an ICP declaration is only due when there were intracommunautaire supplies)');
    }

    const [entityRow] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, declaration.entityId), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entityRow) return error.notFound(c, 'Entity', declaration.entityId);

    const btwNumber = entityRow.taxIdentifiers?.vatNumber;
    if (!btwNumber) {
      return error.badRequest(c, 'VAT/BTW number is not configured on this entity');
    }

    const xmlContent = generateIcpXml({
      btwNumber,
      companyName: entityRow.legalName || entityRow.name,
      periodStart: declaration.periodStart.toISOString(),
      periodEnd: declaration.periodEnd.toISOString(),
      lines: lines.map((line): IcpXmlLine => ({
        vatNumber: line.vatNumber,
        countryCode: line.countryCode,
        supplyType: (line.supplyType as IcpXmlLine['supplyType']) ?? 'services',
        amount: Number(line.amount),
      })),
    });

    const submitResult = await submitFiling(createConfig(c.env, btwNumber), xmlContent, 'Opgaaf ICP');
    if (!submitResult.success) {
      return error.badRequest(c, `Digipoort submission failed: ${submitResult.error}`);
    }

    await db.update(schema.icpDeclarations).set({
      status: 'filed',
      xmlContent,
      filingReference: submitResult.kenmerk || null,
      digipoortResponse: submitResult as unknown as Record<string, unknown>,
      filedAt: new Date(),
      filedBy: userId,
      updatedAt: new Date(),
    }).where(eq(schema.icpDeclarations.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: declaration.entityId,
      entityType: 'icp_declaration',
      entityId: id,
      action: 'filed',
      changes: { status: { old: declaration.status, new: 'filed' } },
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: id, action: 'updated', data: { id, kind: 'icp', status: 'filed' } });

    return success(c, {
      id,
      status: 'filed',
      kenmerk: submitResult.kenmerk,
      digipoortSuccess: submitResult.success,
      simulated: submitResult.simulated ?? false,
    });
  } catch (err) {
    console.error('[app-api/icp-declarations] file failed:', err);
    return error.internal(c, 'Failed to file ICP declaration');
  }
});

// GET /:id/xml — download the ICP XBRL
app.get('/:id/xml', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [declaration] = await db.select().from(schema.icpDeclarations)
      .where(and(eq(schema.icpDeclarations.id, id), isNull(schema.icpDeclarations.deletedAt))).limit(1);
    if (!declaration) return error.notFound(c, 'ICP declaration', id);

    let xmlContent = declaration.xmlContent;
    if (!xmlContent) {
      const lines = await db.select().from(schema.icpLines)
        .where(eq(schema.icpLines.declarationId, id));
      const [entityRow] = await db
        .select()
        .from(schema.entities)
        .where(eq(schema.entities.id, declaration.entityId))
        .limit(1);
      const btwNumber = entityRow?.taxIdentifiers?.vatNumber;
      if (!entityRow || !btwNumber) {
        return error.badRequest(c, 'VAT/BTW number is not configured on this entity');
      }
      xmlContent = generateIcpXml({
        btwNumber,
        companyName: entityRow.legalName || entityRow.name,
        periodStart: declaration.periodStart.toISOString(),
        periodEnd: declaration.periodEnd.toISOString(),
        lines: lines.map((line): IcpXmlLine => ({
          vatNumber: line.vatNumber,
          countryCode: line.countryCode,
          supplyType: (line.supplyType as IcpXmlLine['supplyType']) ?? 'services',
          amount: Number(line.amount),
        })),
      });
    }

    const filename = `opgaaf-icp-${declaration.periodLabel || declaration.id}.xml`;
    return new Response(xmlContent, {
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('[app-api/icp-declarations] xml failed:', err);
    return error.internal(c, 'Failed to get ICP XML');
  }
});

export const icpDeclarationsRoutes = app;
