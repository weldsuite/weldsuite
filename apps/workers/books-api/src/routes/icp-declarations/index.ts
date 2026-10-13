/**
 * Opgaaf ICP routes — flat /api/icp-declarations/* surface.
 *
 * The ICP declaration is legally required alongside the BTW-aangifte whenever
 * the entity had 0%-rated intracommunautaire B2B supplies (rubriek 3b) in the
 * period: a per-customer listing of buyer VAT number, country and net amount.
 * Calculation aggregates the tax ledger's sales lines on the intracommunautaire
 * rates (rubriek 3b), grouped by the buyer's VIES VAT number and by goods
 * (eu_b2b_goods, "leveringen") vs services (eu_b2b_service, "diensten") — credit
 * notes net against the supplies they correct; filing goes through the same
 * Digipoort channel as the VAT return. Calculating a period again updates the
 * open declaration of that period instead of adding a second one; an unfiled
 * declaration can be deleted.
 *
 * Permissions: reports:read | reports:create | reports:update.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { resolveEntityId } from '../../lib/entity-context';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { getContactVatNumber } from '@weldsuite/books-domain/accounting-compliance';
import { normalizeVatNumber } from '@weldsuite/books-domain/vies';
import { generateIcpXml, type IcpXmlLine } from '../../services/accounting-icp-xml';
import { loadTaxLinesForPeriod } from '../../services/accounting-tax-ledger';
import { isUnfiledReturn, parseReturnPeriod } from '../../services/accounting-return-periods';
import { getJurisdictionFeatures } from '@weldsuite/books-domain/jurisdictions/registry';
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

type IcpSupplyType = 'goods' | 'services' | 'triangulation';

interface IcpSourceLine {
  amount: number;
  contactId: string | null;
  supplyType: IcpSupplyType;
}

interface BuyerSupply {
  vatNumber: string;
  countryCode: string;
  contactId: string | null;
  supplyType: IcpSupplyType;
  amount: number;
}

/** Goods leave on the ICL-goods rate; everything else on a 3b rate is a service. */
function supplyTypeOf(taxCategoryCode: string | null | undefined): IcpSupplyType {
  return taxCategoryCode === 'eu_b2b_goods' ? 'goods' : 'services';
}

type NormalizedVat = ReturnType<typeof normalizeVatNumber>;

/** The contact's normalized VAT number, looked up once per contact (`cache`). Null without a contact or number. */
async function buyerVatOf(
  db: Database,
  contactId: string | null,
  cache: Map<string, NormalizedVat>,
): Promise<NormalizedVat | null | undefined> {
  if (!contactId) return null;
  if (cache.has(contactId)) return cache.get(contactId);
  const rawVat = await getContactVatNumber(db, contactId);
  const normalized = rawVat ? normalizeVatNumber(rawVat) : null;
  cache.set(contactId, normalized);
  return normalized;
}

/**
 * Group net supply amounts per buyer VAT number and supply type. The ICP lists
 * goods and services separately, so a buyer who got both has two lines.
 */
async function aggregateSuppliesPerVat(db: Database, lines: IcpSourceLine[]) {
  const perVat = new Map<string, BuyerSupply>();
  const missingVat: string[] = [];
  const vatByContact = new Map<string, NormalizedVat>();

  for (const line of lines) {
    if (line.amount === 0) continue;

    const normalized = await buyerVatOf(db, line.contactId, vatByContact);
    if (!normalized) {
      if (line.contactId && !missingVat.includes(line.contactId)) missingVat.push(line.contactId);
      continue;
    }

    addBuyerSupply(perVat, normalized, line.contactId, line.supplyType, line.amount);
  }
  // A buyer whose credit notes cancel the period's supplies has nothing to report.
  for (const [key, entry] of perVat) {
    entry.amount = Math.round(entry.amount * 100) / 100;
    if (entry.amount === 0) perVat.delete(key);
  }
  return { perVat, missingVat };
}

type BuyerSupplies = Map<string, BuyerSupply>;

/** Add `amount` to the buyer's running total for the supply type, creating the entry on first sight. */
function addBuyerSupply(
  perVat: BuyerSupplies,
  buyer: { full: string; countryCode: string },
  contactId: string | null,
  supplyType: IcpSupplyType,
  amount: number,
): void {
  const key = `${buyer.full}|${supplyType}`;
  const existing = perVat.get(key);
  if (existing) {
    existing.amount += amount;
    return;
  }
  perVat.set(key, { vatNumber: buyer.full, countryCode: buyer.countryCode, contactId, supplyType, amount });
}

/** Persist one ICP line per buyer VAT number and supply type (no-op when there were no supplies). */
async function insertIcpLines(
  db: Database,
  input: {
    declarationId: string;
    entityId: string;
    perVat: BuyerSupplies;
    now: Date;
  },
): Promise<void> {
  const { declarationId, entityId, perVat, now } = input;
  if (perVat.size === 0) return;
  await db.insert(schema.icpLines).values(
    [...perVat.values()].map((entry) => ({
      id: generateId('icpl'),
      declarationId,
      entityId,
      contactId: entry.contactId,
      vatNumber: entry.vatNumber,
      countryCode: entry.countryCode,
      supplyType: entry.supplyType,
      amount: entry.amount.toFixed(2),
      createdAt: now,
      updatedAt: now,
    })),
  );
}

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

    const [entityRow] = await db.select({ jurisdictionCode: schema.entities.jurisdictionCode }).from(schema.entities)
      .where(eq(schema.entities.id, entityId)).limit(1);
    if (!getJurisdictionFeatures(entityRow?.jurisdictionCode).icp) {
      return error.badRequest(c, 'ICP declarations only apply to EU (Dutch) entities');
    }

    const period = parseReturnPeriod(data.periodStart, data.periodEnd);
    if (!period.ok) return error.badRequest(c, period.error);
    const { start: periodStart, end: periodEnd } = period;

    // The period's declaration, when one exists: an open one is recalculated in place, a filed one stands.
    const [existing] = await db
      .select()
      .from(schema.icpDeclarations)
      .where(and(
        eq(schema.icpDeclarations.entityId, entityId),
        eq(schema.icpDeclarations.periodStart, periodStart),
        eq(schema.icpDeclarations.periodEnd, periodEnd),
        isNull(schema.icpDeclarations.deletedAt),
      ))
      .orderBy(desc(schema.icpDeclarations.createdAt))
      .limit(1);
    if (existing && !isUnfiledReturn(existing.status)) {
      return error.badRequest(c, 'The ICP declaration of this period has already been filed.');
    }

    // Sales on the intracommunautaire rates (rubriek 3b) in the period, from the tax ledger.
    const ledgerLines = await loadTaxLinesForPeriod(db, entityId, periodStart, periodEnd);
    const lines = ledgerLines
      .filter((l) => l.direction === 'sales' && l.jurisdictionMetadata?.btwRubriek === '3b')
      .map((l): IcpSourceLine => ({ amount: l.taxableAmount, contactId: l.contactId, supplyType: supplyTypeOf(l.taxCategoryCode) }));

    const { perVat, missingVat } = await aggregateSuppliesPerVat(db, lines);

    const now = new Date();
    const declarationId = existing?.id ?? generateId('icp');
    const totalAmount = [...perVat.values()].reduce((sum, v) => sum + v.amount, 0);
    const notes = missingVat.length > 0
      ? `Supplies for ${missingVat.length} contact(s) were skipped because no VAT number is on their company record: ${missingVat.join(', ')}`
      : null;

    if (existing) {
      await db.update(schema.icpDeclarations).set({
        periodType: data.periodType,
        periodLabel: data.periodLabel || existing.periodLabel,
        status: 'calculated',
        totalAmount: totalAmount.toFixed(2),
        xmlContent: null,
        rejectedAt: null,
        rejectionReason: null,
        notes,
        updatedAt: now,
      }).where(eq(schema.icpDeclarations.id, declarationId));
      await db.delete(schema.icpLines).where(eq(schema.icpLines.declarationId, declarationId));
    } else {
      await db.insert(schema.icpDeclarations).values({
        id: declarationId,
        entityId,
        periodType: data.periodType,
        periodStart,
        periodEnd,
        periodLabel: data.periodLabel || null,
        status: 'calculated',
        totalAmount: totalAmount.toFixed(2),
        notes,
        createdAt: now,
        updatedAt: now,
      });
    }

    await insertIcpLines(db, { declarationId, entityId, perVat, now });

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'icp_declaration',
      entityId: declarationId,
      action: existing ? 'recalculated' : 'calculated',
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: declarationId, action: existing ? 'updated' : 'created', data: { id: declarationId, kind: 'icp', totalAmount } });

    return success(c, {
      id: declarationId,
      totalAmount,
      lineCount: perVat.size,
      skippedContacts: missingVat,
      recalculated: Boolean(existing),
    }, existing ? 200 : 201);
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

    if (!entityRow.contact?.phone) {
      return error.badRequest(c, 'A telephone number is required in the ICP message. Add it to the entity contact details first.');
    }

    const xmlContent = generateIcpXml({
      btwNumber,
      companyName: entityRow.legalName || entityRow.name,
      contactName: entityRow.legalName || entityRow.name,
      contactPhone: entityRow.contact?.phone || '',
      messageReference: `ICP-${id}`,
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
        contactName: entityRow.legalName || entityRow.name,
        contactPhone: entityRow.contact?.phone || '',
        messageReference: `ICP-${id}`,
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

// DELETE /:id — remove a declaration that was not filed yet (recalculate to get a fresh one)
app.delete('/:id', requirePermission('reports:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [declaration] = await db.select().from(schema.icpDeclarations)
      .where(and(eq(schema.icpDeclarations.id, id), isNull(schema.icpDeclarations.deletedAt))).limit(1);
    if (!declaration) return error.notFound(c, 'ICP declaration', id);
    if (!isUnfiledReturn(declaration.status)) {
      return error.badRequest(c, 'A filed ICP declaration can not be deleted.');
    }

    const now = new Date();
    await db.delete(schema.icpLines).where(eq(schema.icpLines.declarationId, id));
    await db.update(schema.icpDeclarations)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(schema.icpDeclarations.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: declaration.entityId,
      entityType: 'icp_declaration',
      entityId: id,
      action: 'deleted',
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: id, action: 'deleted', data: { id, kind: 'icp' } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/icp-declarations] delete failed:', err);
    return error.internal(c, 'Failed to delete ICP declaration');
  }
});

export const icpDeclarationsRoutes = app;
