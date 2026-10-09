/**
 * The payroll routes end to end: the feature flag, permissions per action, the
 * run lifecycle with its events and portal signals, downloads as attachments,
 * structured errors, and the self-service endpoints for My HR and the portal.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { sha256Hex } from '@weldsuite/commerce-domain/portal-tokens';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import { TEST_KEYRING, VALID_IBAN, createTestEmployee, nlWorld, testDeps, type NlWorld } from '../../../test/payroll-fixtures';
import type { Env, Variables } from '../../../types';
import { publicHrPortalRoutes } from '../../public-hr-portal';
import { weldhrRoutes } from '../index';

let db: Database;
let world: NlWorld;

interface Harness {
  request: (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<Response> | Response;
  events: Array<{ eventType: string; data: Record<string, unknown> }>;
  realtime: Array<{ topic: string; event: string; data: { entity: string; id: string } }>;
  settled: () => Promise<void>;
  stored: Map<string, { body: Uint8Array; contentType: string }>;
  kv: Map<string, string>;
  /** Mails handed to the SEND_EMAIL binding: recipient and the raw MIME. */
  mails: Array<{ to: string; raw: string }>;
}

/** The weldhr and portal routers behind a stub auth that sets the identity, permissions and flags. */
function harness(opts: { permissions: string[]; flags?: string[]; userId?: string; payrollDeps?: ReturnType<typeof testDeps>; notify?: boolean }): Harness {
  const events: Harness['events'] = [];
  const realtime: Harness['realtime'] = [];
  const pending: Array<Promise<unknown>> = [];
  const kv = new Map<string, string>();
  const mails: Harness['mails'] = [];
  const base = opts.payrollDeps ?? testDeps();
  // The real notifier (it sends through SEND_EMAIL) instead of the tests' null one.
  const { notifier: _none, ...withoutNotifier } = base.deps;
  void _none;
  const depsOverride = opts.notify ? withoutNotifier : base.deps;
  const flags = new Set(opts.flags ?? []);

  // createTestApp registers the permission middleware's query factory; the routes below rely on it.
  createTestApp('/init', new Hono() as never, {});

  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    const set = c.set as (key: string, value: unknown) => void;
    set('requestId', 'req_test');
    set('userId', opts.userId ?? 'user_hr');
    set('orgId', 'org_test');
    set('sessionId', 'sess');
    set('tenantDb', db);
    set('workspaceId', 'org_test');
    set('userPermissions', permissions(...opts.permissions));
    set('flags', { isOn: async (key: string) => flags.has(key), getValue: async (key: string) => flags.has(key) });
    set('payrollDepsOverride', depsOverride);
    await next();
  });
  app.route('/api/weldhr', weldhrRoutes);
  app.route('/public/hr-portal', publicHrPortalRoutes);

  const env = {
    ENVIRONMENT: 'test',
    SEND_EMAIL: {
      send: async (message: { to: string; raw: unknown }) => {
        mails.push({ to: message.to, raw: typeof message.raw === 'string' ? message.raw : await new Response(message.raw as ReadableStream).text() });
      },
    },
    ENTITY_EVENTS: { send: async (m: { eventType: string; data: Record<string, unknown> }) => void events.push(m) },
    REALTIME: {
      fetch: async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { topic: string; event: string; data: { entity: string; id: string } };
        realtime.push({ topic: body.topic, event: body.event, data: body.data });
        return new Response('{}', { status: 200 });
      },
    },
    WORKSPACE_CACHE: {
      get: async (key: string, type?: string) => {
        const value = kv.get(key);
        return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
    },
  } as unknown as Env;
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p.catch(() => undefined)),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  return {
    events,
    realtime,
    stored: base.stored,
    kv,
    mails,
    settled: async () => {
      await Promise.all(pending);
    },
    request: (path, init = {}) =>
      app.request(
        path,
        {
          method: init.method ?? 'GET',
          headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        },
        env,
        executionCtx,
      ),
  };
}

const ALL = ['payroll:read', 'payroll:prepare', 'payroll:approve', 'payroll:manage'];

beforeAll(async () => {
  db = await createPayrollDb();
}, 120_000);

beforeEach(async () => {
  await resetPayrollTables(db);
  world = await nlWorld(db);
});

async function json<T = any>(res: Response): Promise<{ status: number; data: T; error?: { code: string; message: string; details?: any } }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, data: body.data, error: body.error };
}

describe('the weldhr-payroll flag', () => {
  it('answers 404 on every payroll path without it, whatever the permissions', async () => {
    const h = harness({ permissions: ['*'] });
    for (const path of ['overview', 'employers', 'schedules', 'employees', 'runs', 'filings', 'payslips/x', 'runs/x/payment-file']) {
      expect((await h.request(`/api/weldhr/payroll/${path}`)).status, path).toBe(404);
    }
    expect((await h.request('/api/weldhr/payroll/runs', { method: 'POST', body: {} })).status).toBe(404);
  });

  it('answers 404 on the employee endpoints of My HR and the portal without it', async () => {
    const mine = harness({ permissions: ['employees:self'] });
    for (const path of ['payslips', 'annual-statements', 'payroll-details']) expect((await mine.request(`/api/weldhr/me/${path}`)).status, path).toBe(404);
    expect((await mine.request('/api/weldhr/me/tax-elections', { method: 'POST', body: {} })).status).toBe(404);
    const portal = harness({ permissions: [] });
    await openPortalSession(portal, world.eva.id);
    for (const path of ['payslips', 'annual-statements', 'payroll-details']) {
      expect((await portal.request(`/public/hr-portal/employee/${path}`, { headers: portalAuth })).status, path).toBe(404);
    }
  });

  it('serves them with it', async () => {
    const h = harness({ permissions: ['payroll:read'], flags: ['weldhr-payroll'] });
    const res = await json(await h.request('/api/weldhr/payroll/overview'));
    expect(res.status).toBe(200);
    expect(res.data.setup).toMatchObject({ hasEmployer: true, employeesOnPayroll: 2 });
  });
});

describe('permissions', () => {
  const cases: Array<{ label: string; method: string; path: string; body?: unknown; needs: string }> = [
    { label: 'overview', method: 'GET', path: 'overview', needs: 'payroll:read' },
    { label: 'employers list', method: 'GET', path: 'employers', needs: 'payroll:read' },
    { label: 'create employer', method: 'POST', path: 'employers', body: {}, needs: 'payroll:manage' },
    { label: 'employer bank', method: 'PUT', path: 'employers/x/bank', body: {}, needs: 'payroll:manage' },
    { label: 'create schedule', method: 'POST', path: 'schedules', body: {}, needs: 'payroll:manage' },
    { label: 'employee profile', method: 'PUT', path: 'employees/x/profile', body: {}, needs: 'payroll:prepare' },
    { label: 'payment details', method: 'PUT', path: 'employees/x/payment-details', body: {}, needs: 'payroll:prepare' },
    { label: 'compensation', method: 'POST', path: 'employees/x/compensations', body: {}, needs: 'payroll:prepare' },
    { label: 'create run', method: 'POST', path: 'runs', body: {}, needs: 'payroll:prepare' },
    { label: 'calculate', method: 'POST', path: 'runs/x/calculate', needs: 'payroll:prepare' },
    { label: 'approve', method: 'POST', path: 'runs/x/approve', needs: 'payroll:approve' },
    { label: 'mark paid', method: 'POST', path: 'runs/x/mark-paid', body: {}, needs: 'payroll:approve' },
    { label: 'payment file', method: 'GET', path: 'runs/x/payment-file', needs: 'payroll:approve' },
    { label: 'post journal', method: 'POST', path: 'runs/x/post-journal', needs: 'payroll:approve' },
    { label: 'run report', method: 'GET', path: 'runs/x/report', needs: 'payroll:read' },
    { label: 'generate filing', method: 'POST', path: 'filings/x/generate', needs: 'payroll:manage' },
    { label: 'submit filing', method: 'POST', path: 'filings/x/submit', needs: 'payroll:manage' },
    { label: 'mark filed', method: 'POST', path: 'filings/x/mark-filed', body: {}, needs: 'payroll:manage' },
    { label: 'filing file', method: 'GET', path: 'filings/x/file', needs: 'payroll:read' },
    { label: 'payslip pdf', method: 'GET', path: 'payslips/x/pdf', needs: 'payroll:read' },
  ];

  it.each(cases)('$label needs $needs', async ({ method, path, body, needs }) => {
    // Everything except the needed permission: refused.
    const others = ALL.filter((p) => p !== needs);
    const without = harness({ permissions: [...others, 'employees:read'], flags: ['weldhr-payroll'] });
    expect((await without.request(`/api/weldhr/payroll/${path}`, { method, body })).status).toBe(403);
    // With it: past the permission check (404 or 400 for the made-up ids, never 403).
    const withIt = harness({ permissions: [needs], flags: ['weldhr-payroll'] });
    expect((await withIt.request(`/api/weldhr/payroll/${path}`, { method, body })).status).not.toBe(403);
  });
});

describe('the run lifecycle', () => {
  it('creates, calculates, approves and pays a run; events carry ids and status only; the portal is signalled per employee', async () => {
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const created = await json(await h.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ status: 'draft', employeeCount: 2, canApprove: false, paymentFile: { format: 'sepa', available: false } });
    const runId = created.data.id as string;

    expect((await json(await h.request(`/api/weldhr/payroll/runs/${runId}/collect`, { method: 'POST', body: {} }))).status).toBe(200);
    const input = await json(await h.request(`/api/weldhr/payroll/runs/${runId}/inputs`, { method: 'POST', body: { employeeId: world.eva.id, code: 'bonus', amount: 100 } }));
    expect(input.status).toBe(201);

    const calculated = await json(await h.request(`/api/weldhr/payroll/runs/${runId}/calculate`, { method: 'POST', body: {} }));
    expect(calculated.data).toMatchObject({ status: 'calculated', canApprove: true, errorCount: 0 });
    expect(calculated.data.totals.grossCents).toBe(310_000);
    expect(calculated.data.payslips.map((p: { employeeName: string }) => p.employeeName)).toEqual(['Eva Alder', 'Hans Berg']);

    const approved = await json(await h.request(`/api/weldhr/payroll/runs/${runId}/approve`, { method: 'POST', body: {} }));
    expect(approved.status).toBe(200);
    expect(approved.data).toMatchObject({ status: 'approved', approvedByName: null, paymentFile: { available: true }, journalStatus: 'skipped' });
    await h.settled();

    const types = h.events.map((e) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['hr_pay_run:created', 'hr_pay_run:updated', 'hr_pay_run:calculated', 'hr_pay_run:approved', 'hr_payslip:published', 'hr_payroll_filing:created']));
    expect(types.filter((t) => t === 'hr_payslip:published')).toHaveLength(2);
    // Ids and status only: no amounts, names or notes on the bus.
    for (const event of h.events.filter((e) => e.eventType.startsWith('hr_pay'))) {
      expect(Object.keys(event.data).every((k) => ['id', 'employeeId', 'status'].includes(k)), JSON.stringify(event.data)).toBe(true);
    }
    // The portal hears about each payslip on the employee's own topic.
    const signals = h.realtime.filter((r) => r.data.entity === 'hr_payslip');
    expect(signals.map((s) => s.topic).sort()).toEqual([`hrportal.employee.${world.eva.id}`, `hrportal.employee.${world.hans.id}`].sort());
    expect(signals.every((s) => s.event === 'published')).toBe(true);

    const paid = await json(await h.request(`/api/weldhr/payroll/runs/${runId}/mark-paid`, { method: 'POST', body: { paidOn: '2026-07-24' } }));
    expect(paid.data.status).toBe('paid');
    // The audit trail has the approval and the payment, not their values.
    const audit = await db.select().from(schema.hrAuditEvents);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['payroll.run_approved', 'payroll.run_paid']));
  });

  it('maps service refusals onto coded 409 errors', async () => {
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const run = await json(await h.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    const early = await json(await h.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} }));
    expect(early).toMatchObject({ status: 409, error: { code: 'RUN_NOT_CALCULATED' } });
    const twin = await json(await h.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    expect(twin).toMatchObject({ status: 409, error: { code: 'CONFLICT' } });
    expect((await json(await h.request('/api/weldhr/payroll/runs/nope'))).status).toBe(404);
    // Validation by the shared Zod schemas: a regular run needs its schedule.
    expect((await h.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular' } })).status).toBe(400);
  });

  it('enforces four eyes through the API', async () => {
    await resetPayrollTables(db);
    world = await nlWorld(db, { requireSeparateApprover: true });
    const preparer = harness({ permissions: ['*'], flags: ['weldhr-payroll'], userId: 'user_prep' });
    const run = await json(await preparer.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    await preparer.request(`/api/weldhr/payroll/runs/${run.data.id}/calculate`, { method: 'POST', body: {} });
    const own = await json(await preparer.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} }));
    expect(own).toMatchObject({ status: 409, error: { code: 'FOUR_EYES' } });
    expect((await json(await preparer.request(`/api/weldhr/payroll/runs/${run.data.id}`))).data.canApprove).toBe(false);
    const approver = harness({ permissions: ['*'], flags: ['weldhr-payroll'], userId: 'user_boss' });
    expect((await json(await approver.request(`/api/weldhr/payroll/runs/${run.data.id}`))).data.canApprove).toBe(true);
    expect((await approver.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} })).status).toBe(200);
  });
});

describe('downloads', () => {
  async function approved(h: Harness) {
    const run = await json(await h.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    await h.request(`/api/weldhr/payroll/runs/${run.data.id}/calculate`, { method: 'POST', body: {} });
    await h.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} });
    return run.data.id as string;
  }

  it('sends the payment file, the report, payslip PDFs and filings as attachments', async () => {
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const runId = await approved(h);

    const file = await h.request(`/api/weldhr/payroll/runs/${runId}/payment-file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('Content-Disposition')).toBe('attachment; filename="salary.xml"');
    expect(file.headers.get('Content-Type')).toBe('application/xml');
    expect(file.headers.get('Cache-Control')).toBe('private, no-store');
    const report = await h.request(`/api/weldhr/payroll/runs/${runId}/report`);
    expect(report.headers.get('Content-Disposition')).toMatch(/^attachment; filename="payroll-2026-07-01-2026-07-31.csv"$/);

    const [slip] = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, world.eva.id));
    const pdf = await h.request(`/api/weldhr/payroll/payslips/${slip!.id}/pdf`);
    expect(pdf.headers.get('Content-Type')).toBe('application/pdf');
    expect(pdf.headers.get('Content-Disposition')).toBe('attachment; filename="loonstrook-2026-07.pdf"');
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe('%PDF-');
    expect((await json(await h.request(`/api/weldhr/payroll/payslips/${slip!.id}`))).data).toMatchObject({ number: '2026-0001', netPay: '2400.00', employeeName: 'Eva Alder' });

    const [filing] = await db.select().from(schema.hrPayrollFilings);
    const generated = await json(await h.request(`/api/weldhr/payroll/filings/${filing!.id}/generate`, { method: 'POST', body: {} }));
    expect(generated.data).toMatchObject({ status: 'ready', currency: 'EUR', canSubmit: false, issues: [] });
    const xml = await h.request(`/api/weldhr/payroll/filings/${filing!.id}/file`);
    expect(xml.headers.get('Content-Disposition')).toMatch(/^attachment; filename="loonaangifte-2026.xml"$/);
    // Not configured: a clear coded refusal, whatever the flag says.
    const submit = await json(await h.request(`/api/weldhr/payroll/filings/${filing!.id}/submit`, { method: 'POST', body: {} }));
    expect(submit).toMatchObject({ status: 409, error: { code: 'DIGIPOORT_NOT_CONFIGURED' } });
    const audit = await db.select().from(schema.hrAuditEvents);
    expect(audit.some((a) => a.action === 'payroll.payment_file_downloaded' && JSON.stringify(a.metadata).includes('salary.xml'))).toBe(true);
  });

  it('answers a payment file with errors as 422 and structured issues', async () => {
    const base = testDeps();
    const failing = testDeps({
      engines: { ...base.deps.engines, buildSepaSalaryBatch: () => ({ fileName: 'x.xml', contentType: 'application/xml', content: '', issues: [{ severity: 'error', code: 'invalid_iban', params: { endToEndId: 'x' } }] }) },
    });
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'], payrollDeps: failing });
    const runId = await approved(h);
    const res = await json(await h.request(`/api/weldhr/payroll/runs/${runId}/payment-file`));
    expect(res.status).toBe(422);
    expect(res.error).toMatchObject({ code: 'PAYMENT_FILE_INVALID', details: { issues: [{ severity: 'error', code: 'invalid_iban' }] } });
  });

  it('answers a builder that does not exist yet as unavailable', async () => {
    const base = testDeps();
    const missing = testDeps({
      engines: {
        ...base.deps.engines,
        buildSepaSalaryBatch: () => {
          throw new Error('not implemented yet');
        },
      },
    });
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'], payrollDeps: missing });
    const runId = await approved(h);
    expect((await json(await h.request(`/api/weldhr/payroll/runs/${runId}/payment-file`))).error?.code).toBe('ENGINE_UNAVAILABLE');
  });
});

describe('setup routes', () => {
  it('creates an employer, keeps its bank account masked, audits the change by field names, and refuses an invalid one', async () => {
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const created = await json(await h.request('/api/weldhr/payroll/employers', { method: 'POST', body: { name: 'Beta BV', legalName: 'Beta B.V.', country: 'NL' } }));
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ currency: 'EUR', bank: null });
    const bank = await json(await h.request(`/api/weldhr/payroll/employers/${created.data.id}/bank`, { method: 'PUT', body: { iban: VALID_IBAN, accountHolder: 'Beta B.V.' } }));
    expect(bank.data.bank).toMatchObject({ ibanMasked: 'NL91 •••• •••• 4300', accountHolder: 'Beta B.V.' });
    expect(JSON.stringify(bank.data)).not.toContain('ABNA0417164300');
    expect((await json(await h.request(`/api/weldhr/payroll/employers/${created.data.id}/bank`, { method: 'PUT', body: { iban: 'NL00' } }))).status).toBe(400);
    const audit = (await db.select().from(schema.hrAuditEvents)).filter((a) => a.action === 'payroll.employer_bank_updated');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toEqual({ employerId: created.data.id, fields: ['iban', 'accountHolder'] });
    const del = await h.request(`/api/weldhr/payroll/employers/${created.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  it('writes payment details masked, audits fields (and the bank change separately), and signs paper forms as admin', async () => {
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const res = await json(await h.request(`/api/weldhr/payroll/employees/${world.eva.id}/payment-details`, { method: 'PUT', body: { bankIban: 'NL91ABNA0417164300', dateOfBirth: '1991-02-03' } }));
    expect(res.data).toMatchObject({ bankIbanMasked: 'NL91 •••• •••• 4300', dateOfBirth: '1991-02-03', hasNationalId: true });
    const actions = (await db.select().from(schema.hrAuditEvents)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['payroll.payment_details_updated', 'payroll.bank_changed']));
    expect(h.events.some((e) => e.eventType === 'hr_employee:updated')).toBe(true);

    const election = await json(await h.request(`/api/weldhr/payroll/employees/${world.eva.id}/tax-elections`, { method: 'POST', body: { kind: 'nl_loonheffingskorting', effectiveFrom: '2026-08-01', data: { applyCredit: false }, signatureName: 'Eva Alder' } }));
    expect(election.status).toBe(201);
    expect(election.data).toMatchObject({ source: 'admin', signedBy: 'user_hr', signatureName: 'Eva Alder' });
    const detail = await json(await h.request(`/api/weldhr/payroll/employees/${world.eva.id}`));
    expect(detail.data.compensations).toHaveLength(1);
    expect(detail.data.paymentDetails.bankBic).toBeNull();
  });

  it('lists employees with their readiness and filters on payroll', async () => {
    const h = harness({ permissions: ['payroll:read'], flags: ['weldhr-payroll'] });
    await createTestEmployee(db, { firstName: 'Zed' });
    const all = await json(await h.request('/api/weldhr/payroll/employees'));
    const onPayroll = await json(await h.request('/api/weldhr/payroll/employees?onPayroll=true'));
    expect(all.data).toHaveLength(3);
    expect(onPayroll.data.map((e: { displayName: string }) => e.displayName)).toEqual(['Eva Alder', 'Hans Berg']);
    expect(onPayroll.data[0].issues).toEqual([]);
  });
});

describe('My HR', () => {
  async function approvedJuly() {
    const admin = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const run = await json(await admin.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    await admin.request(`/api/weldhr/payroll/runs/${run.data.id}/calculate`, { method: 'POST', body: {} });
    await admin.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} });
  }

  const evaUser = async () => (await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, world.eva.id)))[0]!.userId!;

  it('lists the caller\'s own payslips and downloads one as an attachment, stamping the first view', async () => {
    await approvedJuly();
    const me = harness({ permissions: ['employees:self'], flags: ['weldhr-payroll'], userId: await evaUser() });
    const list = await json(await me.request('/api/weldhr/me/payslips'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ number: '2026-0001', netPay: '2400.00', viewedAt: null });
    const pdf = await me.request(`/api/weldhr/me/payslips/${list.data[0].id}/pdf`);
    expect(pdf.headers.get('Content-Disposition')).toBe('attachment; filename="loonstrook-2026-07.pdf"');
    expect((await json(await me.request('/api/weldhr/me/payslips'))).data[0].viewedAt).not.toBeNull();
    expect((await db.select().from(schema.hrAuditEvents)).some((a) => a.action === 'payroll.payslip_viewed' && a.employeeId === world.eva.id)).toBe(true);

    // Someone else's payslip does not exist for this caller.
    const other = harness({ permissions: ['employees:self'], flags: ['weldhr-payroll'], userId: (await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, world.hans.id)))[0]!.userId! });
    expect((await other.request(`/api/weldhr/me/payslips/${list.data[0].id}/pdf`)).status).toBe(404);
    // Without employees:self nothing is served.
    const nobody = harness({ permissions: ['payroll:read'], flags: ['weldhr-payroll'], userId: await evaUser() });
    expect((await nobody.request('/api/weldhr/me/payslips')).status).toBe(403);
  });

  it('serves the jaaropgaaf as an attachment', async () => {
    await approvedJuly();
    const me = harness({ permissions: ['employees:self'], flags: ['weldhr-payroll'], userId: await evaUser() });
    const years = await json(await me.request('/api/weldhr/me/annual-statements'));
    expect(years.data).toEqual([{ year: 2026, employerId: world.employerId, employerName: 'Acme BV', kind: 'jaaropgaaf' }]);
    const pdf = await me.request(`/api/weldhr/me/annual-statements/2026?employerId=${world.employerId}`);
    expect(pdf.headers.get('Content-Disposition')).toBe('attachment; filename="jaaropgaaf-2026.pdf"');
    // The employer may be left out when there is only one for the year.
    expect((await me.request('/api/weldhr/me/annual-statements/2026')).status).toBe(200);
    expect((await me.request('/api/weldhr/me/annual-statements/2025')).status).toBe(404);
  });

  it('writes details and signs forms, answering with the full refreshed details each time', async () => {
    const me = harness({ permissions: ['employees:self'], flags: ['weldhr-payroll'], userId: await evaUser() });
    const before = await json(await me.request('/api/weldhr/me/payroll-details'));
    expect(before.data).toMatchObject({ country: 'NL', employerName: 'Acme BV', missing: [], requiredElections: [] });

    const put = await json(await me.request('/api/weldhr/me/payroll-details', { method: 'PUT', body: { bankIban: 'NL91ABNA0417164300', idVerifiedAt: '2026-01-01' } }));
    expect(put.status).toBe(200);
    // The whole HrMyPayrollDetails, so a client can write it straight into its cache.
    expect(Object.keys(put.data).sort()).toEqual(['country', 'elections', 'employerName', 'missing', 'paymentDetails', 'requiredElections']);
    expect(put.data.paymentDetails).toMatchObject({ bankIbanMasked: 'NL91 •••• •••• 4300', idVerifiedAt: '2025-01-02' });
    const actions = (await db.select().from(schema.hrAuditEvents)).filter((a) => a.employeeId === world.eva.id).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['payroll.payment_details_updated', 'payroll.bank_changed']));

    const signed = await json(await me.request('/api/weldhr/me/tax-elections', { method: 'POST', body: { kind: 'nl_loonheffingskorting', effectiveFrom: '2026-09-01', data: { applyCredit: false }, signatureName: 'Eva Alder' } }));
    expect(signed.status).toBe(201);
    expect(Object.keys(signed.data).sort()).toEqual(['country', 'elections', 'employerName', 'missing', 'paymentDetails', 'requiredElections']);
    const elections = await db.select().from(schema.hrTaxElections).where(eq(schema.hrTaxElections.employeeId, world.eva.id));
    const mine = elections.find((e) => e.source === 'employee')!;
    expect(mine).toMatchObject({ signedBy: await evaUser(), signatureName: 'Eva Alder', kind: 'nl_loonheffingskorting' });
    // A US form for a Dutch employee is refused.
    expect((await me.request('/api/weldhr/me/tax-elections', { method: 'POST', body: { kind: 'us_w4', effectiveFrom: '2026-01-01', signatureName: 'Eva', data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false } } })).status).toBe(400);
  });

  it('upper-cases states and lists what is still to sign, with the state certificate definition, for a US employee', async () => {
    const { createEmployer: makeEmployer } = await import('../../../services/weldhr/payroll/employers');
    const { upsertProfile } = await import('../../../services/weldhr/payroll/employees');
    const employer = await makeEmployer(db, { name: 'US Co', legalName: 'US Co Inc', country: 'US' }, { createdBy: 'u', keyring: TEST_KEYRING });
    const pat = await createTestEmployee(db, { firstName: 'Pat' });
    await upsertProfile(db, pat.id, { employerId: employer.id, us: { workState: 'CA' } });
    const me = harness({ permissions: ['employees:self'], flags: ['weldhr-payroll'], userId: (await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, pat.id)))[0]!.userId! });
    const details = await json(await me.request('/api/weldhr/me/payroll-details'));
    expect(details.data.country).toBe('US');
    expect(details.data.missing).toEqual(['nationalId', 'bankRoutingNumber', 'bankAccountNumber', 'bankAccountType', 'homeAddress']);
    expect(details.data.requiredElections.map((r: { kind: string; state: string | null }) => [r.kind, r.state])).toEqual([['us_w4', null], ['us_state_certificate', 'CA']]);
    const certificate = details.data.requiredElections[1].certificate;
    expect(certificate).toMatchObject({ formName: expect.any(String), usesAllowances: expect.any(Boolean) });
    expect(Array.isArray(certificate.fields)).toBe(true);

    // Signing the W-4 leaves only the state certificate.
    const after = await json(await me.request('/api/weldhr/me/tax-elections', { method: 'POST', body: { kind: 'us_w4', effectiveFrom: '2026-01-01', signatureName: 'Pat Doe', data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false } } }));
    expect(after.data.requiredElections.map((r: { kind: string }) => r.kind)).toEqual(['us_state_certificate']);
    expect(after.data.elections.map((e: { kind: string; state: string | null }) => [e.kind, e.state])).toEqual([['us_w4', null]]);
  });
});

// ---------------------------------------------------------------------------
// The workforce portal
// ---------------------------------------------------------------------------

const PORTAL_TOKEN = 'portal-token';
const portalAuth = { Authorization: `Bearer ${PORTAL_TOKEN}` };

async function openPortalSession(h: Harness, employeeId: string) {
  await db.insert(schema.hrPortalSettings).values({ id: 'pst_1', isEnabled: true }).onConflictDoNothing();
  await db.insert(schema.hrPortalAccess).values({ id: `acc_${employeeId}`, kind: 'employee', employeeId, email: 'eva@example.com', status: 'active' }).onConflictDoNothing();
  h.kv.set(
    `hrportal:sess:${await sha256Hex(PORTAL_TOKEN)}`,
    JSON.stringify({ workspaceId: 'org_test', accessId: `acc_${employeeId}`, kind: 'employee', employeeId, companyId: null, personId: null, email: 'eva@example.com' }),
  );
}

describe('the workforce portal', () => {
  it('serves the same four features for the session\'s employee, signs as the portal and downloads as attachments', async () => {
    const admin = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const run = await json(await admin.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    await admin.request(`/api/weldhr/payroll/runs/${run.data.id}/calculate`, { method: 'POST', body: {} });
    await admin.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} });

    const portal = harness({ permissions: [], flags: ['weldhr-payroll'] });
    await openPortalSession(portal, world.eva.id);
    const base = '/public/hr-portal/employee';
    const list = await json(await portal.request(`${base}/payslips`, { headers: portalAuth }));
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(1);
    const pdf = await portal.request(`${base}/payslips/${list.data[0].id}/pdf`, { headers: portalAuth });
    expect(pdf.headers.get('Content-Disposition')).toBe('attachment; filename="loonstrook-2026-07.pdf"');
    const stmt = await portal.request(`${base}/annual-statements/2026?employerId=${world.employerId}`, { headers: portalAuth });
    expect(stmt.headers.get('Content-Disposition')).toBe('attachment; filename="jaaropgaaf-2026.pdf"');
    expect((await json(await portal.request(`${base}/annual-statements`, { headers: portalAuth }))).data).toHaveLength(1);

    const signed = await json(await portal.request(`${base}/tax-elections`, { method: 'POST', headers: portalAuth, body: { kind: 'nl_loonheffingskorting', effectiveFrom: '2026-09-01', data: { applyCredit: true }, signatureName: 'Eva Alder' } }));
    expect(signed.status).toBe(201);
    expect(signed.data.elections).toHaveLength(1);
    const [election] = await db.select().from(schema.hrTaxElections).where(eq(schema.hrTaxElections.signedBy, `portal:${world.eva.id}`));
    expect(election).toMatchObject({ source: 'employee', signatureName: 'Eva Alder' });
    const put = await json(await portal.request(`${base}/payroll-details`, { method: 'PUT', headers: portalAuth, body: { dateOfBirth: '1990-05-18' } }));
    expect(put.data.paymentDetails.dateOfBirth).toBe('1990-05-18');
    expect((await db.select().from(schema.hrAuditEvents)).some((a) => a.actorId === `portal:${world.eva.id}` && a.action === 'payroll.payment_details_updated')).toBe(true);

    // A client session never reaches these.
    expect((await portal.request(`${base}/payslips`)).status).toBe(401);
  });

  it('keeps one employee away from another\'s payslip', async () => {
    const admin = harness({ permissions: ['*'], flags: ['weldhr-payroll'] });
    const run = await json(await admin.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    await admin.request(`/api/weldhr/payroll/runs/${run.data.id}/calculate`, { method: 'POST', body: {} });
    await admin.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} });
    const [hansSlip] = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, world.hans.id));

    const portal = harness({ permissions: [], flags: ['weldhr-payroll'] });
    await openPortalSession(portal, world.eva.id);
    expect((await portal.request(`/public/hr-portal/employee/payslips/${hansSlip!.id}/pdf`, { headers: portalAuth })).status).toBe(404);
  });
});

describe('payroll emails', () => {
  // The mail body may be quoted-printable or base64 inside the MIME: also decode every base64-looking block.
  const mimeText = (raw: string) => {
    const decoded = raw
      .split(String.fromCharCode(10))
      .map((line) => (/^[A-Za-z0-9+/=]{40,}$/.test(line.trim()) ? Buffer.from(line.trim(), 'base64').toString('utf8') : ''))
      .join(' ');
    return `${raw} ${decoded}`;
  };

  it('tells the employee when their bank details change, without the account number, and stays quiet when nothing changed', async () => {
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'], notify: true });
    const url = `/api/weldhr/payroll/employees/${world.eva.id}/payment-details`;
    await h.request(url, { method: 'PUT', body: { bankIban: 'NL91ABNA0417164300' } });
    await h.settled();
    expect(h.mails).toHaveLength(1);
    const [eva] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, world.eva.id));
    expect(h.mails[0]!.to).toBe(eva!.email);
    const text = mimeText(h.mails[0]!.raw);
    expect(text).toContain('bankgegevens');
    expect(text).not.toContain('ABNA0417164300');
    expect(text).not.toContain('0417164300');

    // The same details again: no change, no mail.
    await h.request(url, { method: 'PUT', body: { bankIban: 'NL91ABNA0417164300' } });
    await h.settled();
    expect(h.mails).toHaveLength(1);
  });

  it('also tells them when they change them themselves', async () => {
    const [eva] = await db.select().from(schema.hrEmployees).where(eq(schema.hrEmployees.id, world.eva.id));
    const me = harness({ permissions: ['employees:self'], flags: ['weldhr-payroll'], userId: eva!.userId!, notify: true });
    await me.request('/api/weldhr/me/payroll-details', { method: 'PUT', body: { bankIban: 'NL91ABNA0417164300' } });
    await me.settled();
    expect(me.mails).toHaveLength(1);
    expect(mimeText(me.mails[0]!.raw)).toContain('gewijzigd');
  });

  it('says a payslip is ready to everyone who can read it, never with pay figures', async () => {
    const h = harness({ permissions: ['*'], flags: ['weldhr-payroll'], notify: true });
    const run = await json(await h.request('/api/weldhr/payroll/runs', { method: 'POST', body: { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' } }));
    await h.request(`/api/weldhr/payroll/runs/${run.data.id}/calculate`, { method: 'POST', body: {} });
    await h.request(`/api/weldhr/payroll/runs/${run.data.id}/approve`, { method: 'POST', body: {} });
    await h.settled();
    const people = await db.select().from(schema.hrEmployees);
    expect(h.mails.map((m) => m.to).sort()).toEqual(people.map((p) => p.email).sort());
    const text = mimeText(h.mails[0]!.raw);
    expect(text).toContain('loonstrook');
    expect(text).not.toContain('2400');
    expect(text).not.toContain('3000');
  });
});
