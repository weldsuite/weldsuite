/**
 * 1099 reporting: /api/form-1099 (docs/plans/weldbooks-us.md section 8).
 *
 *   GET  /summary?year=                  per-vendor result, summary, warnings
 *   GET  /vendors/:partyId?year=         drill-down to the payments behind a vendor's boxes
 *   GET  /deadlines?year=                recipient and IRS due dates, e-file rule
 *   GET  /945?year=                      backup withholding for Form 945
 *   GET  /tin-matching/file              IRS TIN Matching upload files (full TINs, logged)
 *   POST /tin-matching/results           {text} the IRS answer; updates each vendor's match status
 *   /filings/...                         filings, lines, IRIS file, copies (./filings.ts)
 *
 * The year is the calendar year the payments were made in (cash basis);
 * without \`year\` it is the last year that has ended, until March, and the
 * current year after that.
 *
 * Permissions: taxes:read | taxes:file, and tax_ids:reveal where full TINs leave.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { writeAccountingAudit } from '@weldsuite/books-domain/accounting-guards';
import {
  FORM_1099_EFILE_THRESHOLD,
  FORM_8508_LEAD_DAYS,
  form1099Deadlines,
  form8508Deadline,
} from '@weldsuite/books-domain/jurisdictions/us/form-1099';
import { error, success } from '@weldsuite/worker-kit/response';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import { applyTinMatchingResults, buildTinMatching } from '../../services/form-1099/outputs';
import { backupWithholdingFor945, summarize1099, vendorDrillDown } from '../../services/form-1099/summary';
import { form1099FilingsRoutes, respondForm1099Error } from './filings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The tax year to show when none is asked for: last year until March, then this year. */
function defaultTaxYear(now = new Date()): number {
  return now.getUTCMonth() < 3 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

function parseYear(c: AppContext): number | Response {
  const raw = c.req.query('year');
  if (raw === undefined || raw === '') return defaultTaxYear();
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2020 || year > new Date().getUTCFullYear() + 1) {
    return error.badRequest(c, 'year must be a tax year from 2020 up to next year');
  }
  return year;
}

// GET /summary
app.get('/summary', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const year = parseYear(c);
    if (typeof year !== 'number') return year;
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    return success(c, await summarize1099(db, entityId, year));
  } catch (err) {
    return respondForm1099Error(c, err, 'compute the 1099 summary');
  }
});

// GET /vendors/:partyId
app.get('/vendors/:partyId', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  const partyId = c.req.param('partyId');
  try {
    const year = parseYear(c);
    if (typeof year !== 'number') return year;
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const detail = await vendorDrillDown(db, entityId, year, partyId);
    if (!detail) return error.notFound(c, 'Vendor', partyId);
    return success(c, detail);
  } catch (err) {
    return respondForm1099Error(c, err, 'fetch the vendor 1099 detail');
  }
});

// GET /deadlines
app.get('/deadlines', requirePermission('taxes:read'), (c) => {
  const year = parseYear(c);
  if (typeof year !== 'number') return year;
  const deadlines = form1099Deadlines(year);
  return success(c, {
    ...deadlines,
    eFile: {
      requiredFrom: FORM_1099_EFILE_THRESHOLD,
      waiverRequestDays: FORM_8508_LEAD_DAYS,
      necWaiverDeadline: form8508Deadline(deadlines.nec.irs),
      miscWaiverDeadline: form8508Deadline(deadlines.misc.irsPaper),
    },
  });
});

// GET /945
app.get('/945', requirePermission('taxes:read'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const year = parseYear(c);
    if (typeof year !== 'number') return year;
    const entityId = await resolveEntityId(c, db);
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    return success(c, await backupWithholdingFor945(db, entityId, year));
  } catch (err) {
    return respondForm1099Error(c, err, 'compute the Form 945 summary');
  }
});

// GET /tin-matching/file: the IRS upload files. Full TINs, so it needs the reveal permission and writes one reveal row per vendor.
app.get('/tin-matching/file', requirePermission('taxes:file'), requirePermission('tax_ids:reveal'), async (c) => {
  const db = c.get('tenantDb');
  try {
    const entityId = await resolveEntityId(c, db);
    const partyIds = c.req.query('partyIds')?.split(',').map((id) => id.trim()).filter(Boolean);
    const result = await buildTinMatching(db, c.env, {
      entityId,
      userId: c.get('userId') ?? 'unknown',
      all: c.req.query('all') === 'true',
      partyIds,
    });
    await writeAccountingAudit(c, db, {
      accountingEntityId: entityId,
      entityType: 'tin_matching',
      entityId: entityId ?? 'workspace',
      action: 'file_created',
      changes: { records: { old: null, new: result.recordCount } },
    });
    c.header('Cache-Control', 'no-store');
    return success(c, result);
  } catch (err) {
    return respondForm1099Error(c, err, 'create the TIN matching file');
  }
});

const resultsSchema = z.object({ text: z.string().min(1).max(5_000_000) });

// POST /tin-matching/results
app.post('/tin-matching/results', requirePermission('taxes:file'), zValidator('json', resultsSchema), async (c) => {
  const db = c.get('tenantDb');
  const { text } = c.req.valid('json');
  try {
    const result = await applyTinMatchingResults(db, text);
    for (const partyId of result.updated) {
      publishEntityEvent({
        c,
        entityType: 'accounting_contact',
        entityId: partyId,
        action: 'updated',
        data: { id: partyId, tinMatchChecked: true },
      });
    }
    await writeAccountingAudit(c, db, {
      entityType: 'tin_matching',
      entityId: 'workspace',
      action: 'results_applied',
      changes: { updated: { old: null, new: result.updated.length } },
    });
    return success(c, result);
  } catch (err) {
    return respondForm1099Error(c, err, 'apply the TIN matching results');
  }
});

app.route('/filings', form1099FilingsRoutes);

export const form1099Routes = app;
