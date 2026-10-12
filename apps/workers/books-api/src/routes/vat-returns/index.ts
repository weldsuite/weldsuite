/**
 * VAT return routes — flat /api/vat-returns/* surface backed by `vatReturns`.
 *
 * Lifecycle: calculated → reviewed → filed → accepted/rejected.
 * POST /calculate aggregates the tax ledger (tax_lines, written with every
 * posting) into the Dutch BTW-aangifte rubrieken (1a–5g) via each tax rate's
 * `jurisdictionMetadata.btwRubriek`; calculating a period again updates the
 * open return of that period (a filed one is corrected with a suppletie), and
 * an unfiled return can be deleted. POST /:id/file renders SBR/XBRL, submits
 * via Digipoort, stamps the period's tax lines with the return and moves the
 * entity's tax lock date to the period end. Filed returns are immutable —
 * corrections happen through a new (suppletie) return. Only entities whose
 * jurisdiction has the `vatReturn` feature (NL) can calculate or file.
 *
 * India (`features.gstReturn`) has no stored return: GET /gst-worksheet computes the
 * GSTR-1 and GSTR-3B summary of a period from the tax ledger on demand. It is a
 * worksheet to reconcile with the GST portal, nothing is filed.
 *
 * Permissions: reports:read | reports:create | reports:update | reports:delete.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { VatRubrieken } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { getJurisdictionFeatures } from '@weldsuite/books-domain/jurisdictions/registry';
import { fileTaxPeriodStatements, nlRubriekenForPeriod } from '../../services/accounting-tax-ledger';
import { resolveEntityId } from '../../lib/entity-context';
import { isKorActive, writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { generateVatXml } from '@weldsuite/books-domain/accounting-vat-xml';
import { normalizeVatRubrieken, recomputeRubriekTotals } from '@weldsuite/books-domain/jurisdictions/nl';
import { isUnfiledReturn, parseReturnPeriod } from '../../services/accounting-return-periods';
import { submitFiling, checkFilingStatus, createConfig } from '../../services/accounting-digipoort';
import { GstReturnError, loadGstWorksheet } from '../../services/accounting-gst-return';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/** A stored return with its rubrieken in the current layout (returns stored before the official numbering are converted). */
function withNormalizedRubrieken<T extends { rubrieken: unknown }>(row: T): T {
  return { ...row, rubrieken: normalizeVatRubrieken(row.rubrieken) } as T;
}

/** The phone number is a mandatory part of the aangifte message. */
const PHONE_REQUIRED_MESSAGE = 'A telephone number is required in the BTW-aangifte message. Add it to the entity contact details first.';

// GET /
app.get('/', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const results = await db
      .select()
      .from(schema.vatReturns)
      .where(and(isNull(schema.vatReturns.deletedAt), eq(schema.vatReturns.entityId, entityId)))
      .orderBy(desc(schema.vatReturns.periodStart));
    return success(c, results.map(withNormalizedRubrieken));
  } catch (err) {
    console.error('[app-api/vat-returns] list failed:', err);
    return error.internal(c, 'Failed to fetch VAT returns');
  }
});

// GET /gst-worksheet?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD — India GSTR-1 / GSTR-3B summary of a period
app.get('/gst-worksheet', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const periodStart = c.req.query('periodStart') ?? '';
  const periodEnd = c.req.query('periodEnd') ?? '';
  const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  if (!isDay(periodStart) || !isDay(periodEnd)) {
    return error.badRequest(c, 'periodStart and periodEnd are required as YYYY-MM-DD dates');
  }
  if (periodStart > periodEnd) return error.badRequest(c, 'periodStart must not be after periodEnd');

  try {
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const [entityRow] = await db
      .select({ jurisdictionCode: schema.entities.jurisdictionCode })
      .from(schema.entities)
      .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entityRow) return error.notFound(c, 'Entity', entityId);
    if (!getJurisdictionFeatures(entityRow.jurisdictionCode).gstReturn) {
      return error.badRequest(c, "This entity's jurisdiction has no GST return.");
    }
    return success(c, await loadGstWorksheet(db, entityId, periodStart, periodEnd));
  } catch (err) {
    if (err instanceof GstReturnError) return error.badRequest(c, err.message);
    console.error('[books-api/vat-returns] gst-worksheet failed:', err);
    return error.internal(c, 'Failed to build the GST worksheet');
  }
});

// GET /:id
app.get('/:id', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [ret] = await db.select().from(schema.vatReturns)
      .where(and(eq(schema.vatReturns.id, id), isNull(schema.vatReturns.deletedAt))).limit(1);
    if (!ret) return error.notFound(c, 'VAT return', id);
    return success(c, withNormalizedRubrieken(ret));
  } catch (err) {
    console.error('[app-api/vat-returns] get failed:', err);
    return error.internal(c, 'Failed to fetch VAT return');
  }
});

// POST /calculate — aggregate rubrieken for a period
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

    const [entityRow] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, entityId), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entityRow) return error.notFound(c, 'Entity', entityId);
    if (!getJurisdictionFeatures(entityRow.jurisdictionCode).vatReturn) {
      return error.badRequest(c, 'This entity\'s jurisdiction has no Dutch VAT return. Use the tax return for its own jurisdiction.');
    }
    if (isKorActive(entityRow)) {
      return error.badRequest(
        c,
        'This entity uses the kleineondernemersregeling (KOR) — no BTW-aangifte is due while KOR is active. Disable KOR in the entity settings if the exemption no longer applies.',
      );
    }

    const period = parseReturnPeriod(data.periodStart, data.periodEnd);
    if (!period.ok) return error.badRequest(c, period.error);
    const { start: periodStart, end: periodEnd } = period;

    // The period's regular return, when one exists: an open one is recalculated in place, a filed one stands
    // (a correction of a filed return is a suppletie, not a second return).
    const [existing] = await db
      .select()
      .from(schema.vatReturns)
      .where(and(
        eq(schema.vatReturns.entityId, entityId),
        eq(schema.vatReturns.periodStart, periodStart),
        eq(schema.vatReturns.periodEnd, periodEnd),
        isNull(schema.vatReturns.correctionOfId),
        isNull(schema.vatReturns.deletedAt),
      ))
      .orderBy(desc(schema.vatReturns.createdAt))
      .limit(1);
    if (existing && !isUnfiledReturn(existing.status)) {
      return error.badRequest(
        c,
        'The BTW-aangifte of this period has already been filed. Use "Check for corrections" on it to file a suppletie.',
      );
    }

    const calculated = await nlRubriekenForPeriod(db, entityId, periodStart, periodEnd);
    // The manual boxes (KOR reduction, estimates) belong to the return, not to the ledger: keep them.
    const kept = existing ? normalizeVatRubrieken(existing.rubrieken) : null;
    const rubrieken = kept
      ? recomputeRubriekTotals({ ...calculated, r5d: kept.r5d, r5e: kept.r5e, r5f: kept.r5f })
      : calculated;

    const now = new Date();
    const vatReturnId = existing?.id ?? generateId('vat');
    if (existing) {
      await db.update(schema.vatReturns).set({
        periodType: data.periodType,
        periodLabel: data.periodLabel || existing.periodLabel,
        status: 'calculated',
        rubrieken,
        xmlContent: null,
        rejectedAt: null,
        rejectionReason: null,
        updatedAt: now,
      }).where(eq(schema.vatReturns.id, vatReturnId));
    } else {
      await db.insert(schema.vatReturns).values({
        id: vatReturnId,
        entityId,
        periodType: data.periodType,
        periodStart,
        periodEnd,
        periodLabel: data.periodLabel || null,
        status: 'calculated',
        rubrieken,
        createdAt: now,
        updatedAt: now,
      });
    }

    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'vat_return',
      entityId: vatReturnId,
      action: existing ? 'recalculated' : 'calculated',
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: vatReturnId, action: existing ? 'updated' : 'created', data: { id: vatReturnId, rubrieken } });

    return success(c, { id: vatReturnId, rubrieken, recalculated: Boolean(existing) }, existing ? 200 : 201);
  } catch (err) {
    console.error('[app-api/vat-returns] calculate failed:', err);
    return error.internal(c, 'Failed to calculate VAT return');
  }
});

// PATCH /:id — manual rubriek adjustments / review. Filed returns are immutable.
app.patch('/:id', requirePermission('reports:update'), zValidator('json', z.object({
  rubrieken: z.record(z.number()).optional(),
  notes: z.string().optional(),
})), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');

  try {
    const [ret] = await db.select().from(schema.vatReturns)
      .where(and(eq(schema.vatReturns.id, id), isNull(schema.vatReturns.deletedAt))).limit(1);
    if (!ret) return error.notFound(c, 'VAT return', id);
    if (!isUnfiledReturn(ret.status)) {
      return error.badRequest(c, 'Filed VAT returns are immutable — file a correction (suppletie) instead');
    }

    const updateData: Record<string, unknown> = { status: 'reviewed', updatedAt: new Date() };
    if (data.rubrieken) {
      // Merge the adjusted boxes into the return's current ones and recompute 5a / 5c / 5g.
      const current = normalizeVatRubrieken(ret.rubrieken) ?? normalizeVatRubrieken({ r5g: 0 })!;
      const adjusted = { ...current };
      for (const key of Object.keys(current) as Array<keyof VatRubrieken>) {
        const value = data.rubrieken[key];
        if (typeof value === 'number' && Number.isFinite(value)) adjusted[key] = Math.round(value * 100) / 100;
      }
      updateData.rubrieken = recomputeRubriekTotals(adjusted);
    }
    if (data.notes !== undefined) updateData.notes = data.notes;

    await db.update(schema.vatReturns).set(updateData).where(eq(schema.vatReturns.id, id));

    await writeAccountingAudit(c, db, {
      accountingEntityId: ret.entityId,
      entityType: 'vat_return',
      entityId: id,
      action: 'reviewed',
      changes: data.rubrieken
        ? { rubrieken: { old: ret.rubrieken, new: updateData.rubrieken } }
        : undefined,
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: id, action: 'updated', data: { ...ret, ...updateData } as unknown as Record<string, unknown> });

    return success(c, withNormalizedRubrieken({ ...ret, ...updateData }));
  } catch (err) {
    console.error('[app-api/vat-returns] update failed:', err);
    return error.internal(c, 'Failed to update VAT return');
  }
});

// POST /:id/file — generate SBR/XBRL and submit via Digipoort
app.post('/:id/file', requirePermission('reports:update'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const userId = c.get('userId');

  try {
    const [ret] = await db.select().from(schema.vatReturns)
      .where(and(eq(schema.vatReturns.id, id), isNull(schema.vatReturns.deletedAt))).limit(1);
    if (!ret) return error.notFound(c, 'VAT return', id);
    const rubriekenToFile = normalizeVatRubrieken(ret.rubrieken);
    if (!rubriekenToFile) return error.badRequest(c, 'VAT return has no calculated rubrieken');
    if (!isUnfiledReturn(ret.status)) {
      return error.badRequest(c, 'VAT return has already been filed');
    }

    const [entityRow] = await db
      .select()
      .from(schema.entities)
      .where(and(eq(schema.entities.id, ret.entityId), isNull(schema.entities.deletedAt)))
      .limit(1);
    if (!entityRow) return error.notFound(c, 'Entity', ret.entityId);

    const btwNumber = entityRow.taxIdentifiers?.vatNumber;
    if (!btwNumber) {
      return error.badRequest(c, 'VAT/BTW number is not configured on this entity');
    }

    if (!entityRow.contact?.phone) return error.badRequest(c, PHONE_REQUIRED_MESSAGE);

    const xmlContent = generateVatXml({
      btwNumber,
      companyName: entityRow.legalName || entityRow.name,
      contactName: entityRow.legalName || entityRow.name,
      contactPhone: entityRow.contact?.phone || '',
      periodStart: ret.periodStart.toISOString(),
      periodEnd: ret.periodEnd.toISOString(),
      rubrieken: rubriekenToFile,
      messageReference: `OB-${id}`,
    });

    // Mode + mTLS certificate come from the environment: DIGIPOORT_MODE
    // (simulated | preprod | production) and the DIGIPOORT_CERT binding.
    const digipoortConfig = createConfig(c.env, btwNumber);

    const submitResult = await submitFiling(digipoortConfig, xmlContent);
    if (!submitResult.success) {
      return error.badRequest(c, `Digipoort submission failed: ${submitResult.error}`);
    }

    await atomically(db, (h) => [
      h.update(schema.vatReturns).set({
        status: 'filed',
        rubrieken: rubriekenToFile,
        xmlContent,
        filingReference: submitResult.kenmerk || null,
        digipoortResponse: submitResult as unknown as Record<string, unknown>,
        filedAt: new Date(),
        filedBy: userId,
        updatedAt: new Date(),
      }).where(eq(schema.vatReturns.id, id)),
      // A suppletie corrects an already-stamped period; only regular returns stamp rows.
      ...(ret.correctionOfId
        ? []
        : fileTaxPeriodStatements(h, {
            entityId: ret.entityId,
            periodStart: ret.periodStart,
            periodEnd: ret.periodEnd,
            taxReturnId: id,
            currentTaxLockDate: entityRow.taxLockDate,
          })),
    ]);

    await writeAccountingAudit(c, db, {
      accountingEntityId: ret.entityId,
      entityType: 'vat_return',
      entityId: id,
      action: 'filed',
      changes: { status: { old: ret.status, new: 'filed' } },
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: id, action: 'updated', data: { id, status: 'filed' } });

    return success(c, {
      id,
      status: 'filed',
      kenmerk: submitResult.kenmerk,
      digipoortSuccess: submitResult.success,
      message: submitResult.success
        ? 'BTW-aangifte submitted to Digipoort'
        : `Filing failed: ${submitResult.error}`,
    });
  } catch (err) {
    console.error('[app-api/vat-returns] file failed:', err);
    return error.internal(c, 'Failed to file VAT return');
  }
});

// POST /:id/suppletie — build a correction return against a FILED return.
// Recalculates the period from the current ledger and diffs against the
// filed rubrieken. Belastingdienst rules: net corrections ≤ €1,000 may be
// folded into the next regular return; larger ones require a separate
// suppletie within 8 weeks of discovering the error.
app.post('/:id/suppletie', requirePermission('reports:create'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  try {
    const [original] = await db.select().from(schema.vatReturns)
      .where(and(eq(schema.vatReturns.id, id), isNull(schema.vatReturns.deletedAt))).limit(1);
    if (!original) return error.notFound(c, 'VAT return', id);
    if (isUnfiledReturn(original.status)) {
      return error.badRequest(c, 'Suppletie only applies to filed returns — unfiled returns can simply be recalculated');
    }
    if (!original.rubrieken) return error.badRequest(c, 'Original return has no rubrieken');

    // Recalculate the same period from the tax ledger as it stands NOW.
    const recalculated = await nlRubriekenForPeriod(db, original.entityId, original.periodStart, original.periodEnd);

    const filed = normalizeVatRubrieken(original.rubrieken) as VatRubrieken;
    const netDiff = Math.round(((recalculated.r5g ?? 0) - (filed.r5g ?? 0)) * 100) / 100;

    if (netDiff === 0) {
      return success(c, {
        correctionRequired: false,
        netDiff: 0,
        message: 'The ledger matches the filed return — no suppletie needed.',
      });
    }

    // ≤ €1,000 (absolute): fold into the next regular return — no separate
    // suppletie filing required. We still report the diff so the user can
    // adjust the next return consciously.
    if (Math.abs(netDiff) <= 1000) {
      return success(c, {
        correctionRequired: false,
        foldIntoNextReturn: true,
        netDiff,
        recalculated,
        message: `Net correction of €${netDiff.toFixed(2)} is within the €1,000 threshold — it may be folded into the next regular BTW-aangifte instead of a separate suppletie.`,
      });
    }

    // > €1,000: create the suppletie return (8-week clock from discovery).
    const now = new Date();
    const deadline = new Date(now.getTime() + 8 * 7 * 24 * 3600 * 1000);
    const suppletieId = generateId('vat');
    await db.insert(schema.vatReturns).values({
      id: suppletieId,
      entityId: original.entityId,
      periodType: original.periodType,
      periodStart: original.periodStart,
      periodEnd: original.periodEnd,
      periodLabel: original.periodLabel ? `${original.periodLabel} (suppletie)` : 'Suppletie',
      status: 'calculated',
      rubrieken: recalculated,
      correctionOfId: original.id,
      suppletieDeadline: deadline,
      notes: `Suppletie of ${original.periodLabel ?? original.id}: net difference €${netDiff.toFixed(2)} vs the filed return. Must be filed by ${deadline.toISOString().slice(0, 10)} (8 weeks after discovery).`,
      createdAt: now,
      updatedAt: now,
    });

    await writeAccountingAudit(c, db, {
      accountingEntityId: original.entityId,
      entityType: 'vat_return',
      entityId: suppletieId,
      action: 'suppletie_created',
      changes: { netDiff: { old: 0, new: netDiff }, correctionOfId: { old: null, new: original.id } },
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: suppletieId, action: 'created', data: { id: suppletieId, correctionOfId: original.id, netDiff } });

    return success(c, {
      correctionRequired: true,
      id: suppletieId,
      netDiff,
      recalculated,
      suppletieDeadline: deadline.toISOString(),
      message: `Suppletie created — net correction €${netDiff.toFixed(2)} exceeds the €1,000 threshold. File it via Digipoort before ${deadline.toISOString().slice(0, 10)}.`,
    }, 201);
  } catch (err) {
    console.error('[app-api/vat-returns] suppletie failed:', err);
    return error.internal(c, 'Failed to create suppletie');
  }
});

// GET /:id/filing-status — poll Digipoort for the filing's processing status
app.get('/:id/filing-status', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [ret] = await db.select().from(schema.vatReturns)
      .where(and(eq(schema.vatReturns.id, id), isNull(schema.vatReturns.deletedAt))).limit(1);
    if (!ret) return error.notFound(c, 'VAT return', id);
    if (!ret.filingReference) {
      return error.badRequest(c, 'VAT return has not been filed yet');
    }

    const [entityRow] = await db
      .select()
      .from(schema.entities)
      .where(eq(schema.entities.id, ret.entityId))
      .limit(1);
    const btwNumber = entityRow?.taxIdentifiers?.vatNumber ?? '';

    const statusResult = await checkFilingStatus(createConfig(c.env, btwNumber), ret.filingReference);

    // Persist terminal states so the UI reflects them without re-polling
    if (statusResult.success && statusResult.status === 'accepted' && ret.status !== 'accepted') {
      await db.update(schema.vatReturns)
        .set({ status: 'accepted', acceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.vatReturns.id, id));
      await writeAccountingAudit(c, db, {
        accountingEntityId: ret.entityId,
        entityType: 'vat_return',
        entityId: id,
        action: 'accepted',
      });
    } else if (statusResult.success && statusResult.status === 'rejected' && ret.status !== 'rejected') {
      await db.update(schema.vatReturns)
        .set({
          status: 'rejected',
          rejectedAt: new Date(),
          rejectionReason: statusResult.statusDescription ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.vatReturns.id, id));
      await writeAccountingAudit(c, db, {
        accountingEntityId: ret.entityId,
        entityType: 'vat_return',
        entityId: id,
        action: 'rejected',
        changes: { rejectionReason: { old: null, new: statusResult.statusDescription ?? null } },
      });
    }

    return success(c, {
      id,
      kenmerk: ret.filingReference,
      ...statusResult,
    });
  } catch (err) {
    console.error('[app-api/vat-returns] filing-status failed:', err);
    return error.internal(c, 'Failed to check filing status');
  }
});

// GET /:id/xml — download SBR/XBRL XML
app.get('/:id/xml', requirePermission('reports:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const id = c.req.param('id');
    const [ret] = await db.select().from(schema.vatReturns)
      .where(and(eq(schema.vatReturns.id, id), isNull(schema.vatReturns.deletedAt))).limit(1);
    if (!ret) return error.notFound(c, 'VAT return', id);

    let xmlContent = ret.xmlContent;

    if (!xmlContent) {
      const rubriekenForXml = normalizeVatRubrieken(ret.rubrieken);
      if (!rubriekenForXml) {
        return error.badRequest(c, 'VAT return has no calculated rubrieken');
      }
      const [entityRow] = await db
        .select()
        .from(schema.entities)
        .where(and(eq(schema.entities.id, ret.entityId), isNull(schema.entities.deletedAt)))
        .limit(1);
      const btwNumber = entityRow?.taxIdentifiers?.vatNumber;
      if (!entityRow || !btwNumber) {
        return error.badRequest(c, 'VAT/BTW number is not configured on this entity');
      }
      xmlContent = generateVatXml({
        btwNumber,
        companyName: entityRow.legalName || entityRow.name,
        contactName: entityRow.legalName || entityRow.name,
        contactPhone: entityRow.contact?.phone || '',
        periodStart: ret.periodStart.toISOString(),
        periodEnd: ret.periodEnd.toISOString(),
        rubrieken: rubriekenForXml,
        messageReference: `OB-${id}`,
      });
    }

    const filename = `btw-aangifte-${ret.periodLabel || ret.id}.xml`;
    return new Response(xmlContent, {
      headers: {
        'Content-Type': 'application/xml',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error('[app-api/vat-returns] xml failed:', err);
    return error.internal(c, 'Failed to get XML');
  }
});

// DELETE /:id — remove a return that was not filed yet (recalculate to get a fresh one)
app.delete('/:id', requirePermission('reports:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [ret] = await db.select().from(schema.vatReturns)
      .where(and(eq(schema.vatReturns.id, id), isNull(schema.vatReturns.deletedAt))).limit(1);
    if (!ret) return error.notFound(c, 'VAT return', id);
    if (!isUnfiledReturn(ret.status)) {
      return error.badRequest(c, 'A filed VAT return can not be deleted — correct it with a suppletie instead');
    }

    const now = new Date();
    await db.update(schema.vatReturns)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(schema.vatReturns.id, id), ne(schema.vatReturns.status, 'filed')));

    await writeAccountingAudit(c, db, {
      accountingEntityId: ret.entityId,
      entityType: 'vat_return',
      entityId: id,
      action: 'deleted',
      changes: { status: { old: ret.status, new: 'deleted' } },
    });
    publishEntityEvent({ c, entityType: 'vat_return', entityId: id, action: 'deleted', data: { id } });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/vat-returns] delete failed:', err);
    return error.internal(c, 'Failed to delete VAT return');
  }
});

export const vatReturnsRoutes = app;
