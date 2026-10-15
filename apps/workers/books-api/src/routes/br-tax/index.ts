/**
 * Brazil tax worksheet and exports — /api/br-tax.
 *
 *   GET  /apuracao?period=YYYY-MM          the month's worksheet (DAS / MEI, ISS, ICMS, IPI, PIS, COFINS,
 *                                          withholdings to pay, withheld by customers, IRPJ/CSLL at quarter end)
 *                                          with `status` open | booked
 *   POST /apuracao/book {period}           post the DAS, IRPJ/CSLL and withholding offsets, keep the worksheet
 *   POST /ecd {year, signatories}          the SPED ECD file of the fiscal year (ISO-8859-1), warnings in X-Warnings
 *   GET  /withholdings/suggest?contactId=&serviceKind=
 *                                          the federal withholdings that apply to a service sold to the contact
 *
 * Only for entities whose jurisdiction has the feature (brTaxReturn / spedEcd).
 * Permissions: taxes:read; taxes:file to book a month.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import { getContactVatNumber } from '@weldsuite/books-domain/accounting-compliance';
import { getJurisdictionFeatures } from '@weldsuite/books-domain/jurisdictions/registry';
import { brRegimeOf, encodeLatin1, suggestBrWithholdings } from '@weldsuite/books-domain/jurisdictions/br';
import { error, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import { BrApuracaoError, bookApuracao, computeEntityApuracao, storedApuracao } from '../../services/br-apuracao';
import { BrEcdError, buildEntityEcd } from '../../services/br-ecd';
import { PostingError } from '../../services/accounting-posting';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a YYYY-MM period');

const signatorySchema = z.object({
  name: z.string().trim().min(1).max(255),
  taxId: z.string().trim().regex(/^[\d./-]{11,18}$/, 'CPF or CNPJ'),
  code: z.string().regex(/^\d{3}$/, 'The qualification code has 3 digits (900 = contador)'),
  qualification: z.string().trim().min(1).max(100),
  crc: z.string().trim().max(20).optional(),
  crcUf: z.string().trim().length(2).optional(),
  email: z.string().email().max(60).optional(),
  phone: z.string().trim().max(14).optional(),
  legalRepresentative: z.boolean(),
});

const ecdSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  signatories: z.array(signatorySchema).min(1).max(10),
});

async function brEntity(c: Ctx, feature: 'brTaxReturn' | 'spedEcd') {
  const db = c.get('tenantDb');
  const entityId = await resolveEntityId(c, db);
  if (!entityId) return { error: error.badRequest(c, 'No accounting entity resolved') };
  const [entity] = await db.select().from(schema.entities).where(eq(schema.entities.id, entityId)).limit(1);
  if (!entity) return { error: error.notFound(c, 'Entity', entityId) };
  if (!getJurisdictionFeatures(entity.jurisdictionCode)[feature]) {
    return { error: error.badRequest(c, 'This is only available for Brazilian entities') };
  }
  return { entity };
}

// GET /apuracao?period=YYYY-MM
app.get('/apuracao', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const period = periodSchema.safeParse(c.req.query('period'));
  if (!period.success) return error.badRequest(c, period.error.issues[0].message);
  try {
    const resolved = await brEntity(c, 'brTaxReturn');
    if ('error' in resolved) return resolved.error;
    const stored = await storedApuracao(db, resolved.entity.id, period.data);
    if (stored.taxReturnId) {
      // A booked month shows what was booked.
      const [row] = await db
        .select({ summary: schema.taxReturns.summary })
        .from(schema.taxReturns)
        .where(eq(schema.taxReturns.id, stored.taxReturnId))
        .limit(1);
      if (row?.summary) return success(c, { ...row.summary, ...stored });
    }
    const apuracao = await computeEntityApuracao(db, resolved.entity, period.data);
    return success(c, { ...apuracao, ...stored });
  } catch (err) {
    if (err instanceof BrApuracaoError) return error.badRequest(c, err.message);
    console.error('[books-api/br-tax] apuracao failed:', err);
    return error.internal(c, 'Failed to work out the apuração');
  }
});

// POST /apuracao/book
app.post('/apuracao/book', requirePermission('taxes:file'), zValidator('json', z.object({ period: periodSchema })), async (c) => {
  const db = c.get('tenantDb');
  const { period } = c.req.valid('json');
  try {
    const resolved = await brEntity(c, 'brTaxReturn');
    if ('error' in resolved) return resolved.error;
    const booked = await bookApuracao(db, resolved.entity, period, c.get('userId') ?? null);
    await writeAccountingAudit(c, db, {
      accountingEntityId: resolved.entity.id,
      entityType: 'tax_return',
      entityId: booked.taxReturnId,
      action: 'created',
    });
    publishEntityEvent({
      c,
      entityType: 'tax_return',
      entityId: booked.taxReturnId,
      action: 'created',
      data: { id: booked.taxReturnId, entityId: resolved.entity.id, jurisdictionCode: 'BR', period, totalDue: booked.apuracao.total },
    });
    return success(c, { taxReturnId: booked.taxReturnId, journalEntryId: booked.journalEntryId }, 201);
  } catch (err) {
    if (err instanceof BrApuracaoError || err instanceof PostingError) return error.badRequest(c, err.message);
    console.error('[books-api/br-tax] book failed:', err);
    return error.internal(c, 'Failed to book the apuração');
  }
});

// POST /ecd
app.post('/ecd', requirePermission('taxes:read'), zValidator('json', ecdSchema), async (c) => {
  const db = c.get('tenantDb');
  const { year, signatories } = c.req.valid('json');
  try {
    const resolved = await brEntity(c, 'spedEcd');
    if ('error' in resolved) return resolved.error;
    const ecd = await buildEntityEcd(db, resolved.entity, year, signatories);
    const cnpj = (resolved.entity.taxIdentifiers?.vatNumber ?? '').replace(/[^0-9A-Z]/gi, '');
    return new Response(encodeLatin1(ecd.content), {
      headers: {
        'Content-Type': 'text/plain; charset=ISO-8859-1',
        'Content-Disposition': `attachment; filename="ECD-${cnpj}-${year}.txt"`,
        'X-Warnings': encodeURIComponent(JSON.stringify(ecd.warnings)),
        'Access-Control-Expose-Headers': 'X-Warnings, Content-Disposition',
      },
    });
  } catch (err) {
    if (err instanceof BrEcdError) return error.badRequest(c, err.message);
    console.error('[books-api/br-tax] ecd failed:', err);
    return error.internal(c, 'Failed to build the ECD');
  }
});

// GET /withholdings/suggest?contactId=&serviceKind=
app.get('/withholdings/suggest', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const kind = z.enum(['professional', 'cleaning_security', 'other']).optional().safeParse(c.req.query('serviceKind') || undefined);
  if (!kind.success) return error.badRequest(c, 'serviceKind must be professional, cleaning_security or other');
  try {
    const resolved = await brEntity(c, 'brTaxReturn');
    if ('error' in resolved) return resolved.error;
    const taxId = (await getContactVatNumber(db, c.req.query('contactId'))) ?? '';
    return success(
      c,
      suggestBrWithholdings({
        providerRegime: brRegimeOf(resolved.entity.taxClassification),
        takerIsCompany: taxId.replace(/[^0-9A-Z]/gi, '').length === 14,
        serviceKind: kind.data,
      }),
    );
  } catch (err) {
    console.error('[books-api/br-tax] suggest failed:', err);
    return error.internal(c, 'Failed to suggest withholdings');
  }
});

export const brTaxRoutes = app;
