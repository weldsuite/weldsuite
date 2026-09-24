/**
 * Public WeldHR workforce portal — /public/hr-portal/*
 *
 * UNAUTHENTICATED mount (no Clerk). The tenant is resolved from `?slug=` /
 * `X-Workspace-Slug` (same middleware as the commerce portal). Sign-in is an
 * emailed one-time code; the session is a random token whose SHA-256 is the KV
 * key, re-checked against `hr_portal_access` on every request so a revoke in
 * the back office takes effect immediately.
 *
 * Two principals:
 *   - employee → only their own rows, looked up by the employee id stored in
 *     the session (never taken from the request).
 *   - client   → the team on their company, and only what the workspace has
 *     explicitly shared (see services/weldhr/client-view).
 *
 * `/auth/request` answers the same way whether or not the email has access,
 * so the endpoint cannot be used to discover who works where.
 */

import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import {
  hrPortalAcknowledgeSchema,
  hrPortalAuthRequestSchema,
  hrPortalAuthVerifySchema,
  hrPortalClientRequestSchema,
  hrPortalClockSchema,
  hrPortalLeaveRequestSchema,
  hrPortalSelectAccessSchema,
} from '@weldsuite/app-api-client/schemas/weldhr';
import { publishEntityEvent, type ActionFor, type DataFor, type EntityType } from '@weldsuite/entity-events';
import type { HrPortalSettings } from '@weldsuite/db/schema';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { schema } from '../../db';
import { commercePortalSlugMiddleware } from '../../middleware/commerce-portal-slug';
import {
  kvDelete,
  kvGetJson,
  kvPutJson,
  randomOtp,
  randomToken,
  sha256Hex,
} from '../../lib/commerce-portal-tokens';
import { buildClientView, clientTeam } from '../../services/weldhr/client-view';
import { acknowledgeCoachingLog, acknowledgeEvaluation, listEvaluations, listKpiValues, listMilestones } from '../../services/weldhr/performance';
import { grantsForEmail, loadPortalSettings } from '../../services/weldhr/portal';
import { resolvePortalHost, sendHrPortalCodeEmail } from '../../services/weldhr/portal-mail';
import { mintPortalRealtimeTicket, notifyPortal } from '../../services/weldhr/portal-realtime';
import {
  clientRequests,
  completeEmployeeTask,
  createClientRequest,
  employeeAttendance,
  employeeCoaching,
  employeeEvaluations,
  employeeLeave,
  employeeOverview,
  employeePerformance,
  employeeProfile,
  employeeTasks,
} from '../../services/weldhr/portal-self-service';
import {
  HrConflictError,
  HrNotFoundError,
  HrValidationError,
  addDays,
  companyNames,
  recordHrAudit,
  todayIso,
} from '../../services/weldhr/shared';
import { cancelLeaveRequest, clock, createLeaveRequest } from '../../services/weldhr/time';

const OTP_TTL_SECONDS = 15 * 60;
const PICKER_TTL_SECONDS = 10 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_OTP_ATTEMPTS = 5;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_TTL_SECONDS = 15 * 60;

interface HrPortalChallenge {
  workspaceId: string;
  email: string;
  otpHash: string;
  attempts: number;
}

interface HrPortalSession {
  workspaceId: string;
  accessId: string;
  kind: 'employee' | 'client';
  employeeId: string | null;
  companyId: string | null;
  personId: string | null;
  email: string;
}

interface HrPortalPicker {
  workspaceId: string;
  email: string;
  accessIds: string[];
}

const kv = {
  otp: (workspaceId: string, email: string) => `hrportal:otp:${workspaceId}:${email}`,
  rate: (workspaceId: string, email: string) => `hrportal:rl:${workspaceId}:${email}`,
  session: (hash: string) => `hrportal:sess:${hash}`,
  picker: (hash: string) => `hrportal:pick:${hash}`,
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
type PortalContext = Context<{ Bindings: Env; Variables: Variables }>;

app.onError((err, c) => {
  if (err instanceof HrNotFoundError) return error.notFound(c, err.resource, err.id);
  if (err instanceof HrValidationError) return error.badRequest(c, err.message);
  if (err instanceof HrConflictError) return error.conflict(c, err.message);
  console.error('[public-hr-portal] unhandled error:', err);
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }, 500);
});

/**
 * Custom domain → workspace slug, for the portal app's host rewrite. Runs
 * before the slug middleware because the whole point is that there is no
 * slug yet. Returns only the slug, which is already public in portal URLs.
 */
app.get('/resolve-host', async (c) => {
  const host = c.req.query('host')?.trim().toLowerCase();
  if (!host || host.length > 255) return error.badRequest(c, 'Missing host');
  const mapping = await resolvePortalHost(c.env, host);
  if (!mapping) return error.notFound(c, 'Portal host', host);
  return success(c, { slug: mapping.slug });
});

const slugMiddleware = commercePortalSlugMiddleware();
app.use('*', async (c, next) => {
  if (c.req.path.endsWith('/resolve-host')) return next();
  return slugMiddleware(c, async () => {
    // The slug middleware sets the master workspace id, but the back office
    // (Clerk routes) keys entity events, realtime hubs and the custom-domain
    // map by the Clerk org id. Use that here too, or a leave request filed in
    // the portal is published to a hub nobody in the back office listens on.
    const orgId = c.get('orgId');
    if (orgId) c.set('workspaceId', orgId);
    await next();
  });
});

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function clientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || null;
}

function kindEnabled(settings: HrPortalSettings, kind: string): boolean {
  return kind === 'employee' ? settings.employeePortalEnabled : settings.clientPortalEnabled;
}

/** Branding + feature switches only. No workspace data. */
function publicConfig(settings: HrPortalSettings) {
  return {
    displayName: settings.displayName,
    logoUrl: settings.logoUrl,
    faviconUrl: settings.faviconUrl,
    primaryColor: settings.primaryColor,
    accentColor: settings.accentColor,
    welcomeMessage: settings.welcomeMessage,
    supportEmail: settings.supportEmail,
    hideWeldsuiteBranding: settings.hideWeldsuiteBranding,
    employeePortalEnabled: settings.employeePortalEnabled,
    clientPortalEnabled: settings.clientPortalEnabled,
    features: {
      selfClockIn: settings.employeeSelfClockIn,
      leaveRequests: settings.employeeLeaveRequests,
      individualScores: settings.clientCanSeeIndividualScores,
    },
  };
}

async function enabledSettings(c: { get: (k: 'tenantDb') => Variables['tenantDb'] }) {
  const settings = await loadPortalSettings(c.get('tenantDb'));
  return settings.isEnabled ? settings : null;
}

async function openSession(
  c: PortalContext,
  access: { id: string; kind: string; employeeId: string | null; companyId: string | null; personId: string | null; email: string },
) {
  const db = c.get('tenantDb');
  const token = randomToken();
  const session: HrPortalSession = {
    workspaceId: c.get('workspaceId'),
    accessId: access.id,
    kind: access.kind === 'client' ? 'client' : 'employee',
    employeeId: access.employeeId,
    companyId: access.companyId,
    personId: access.personId,
    email: normalizeEmail(access.email),
  };
  await kvPutJson(c.env, kv.session(await sha256Hex(token)), session, SESSION_TTL_SECONDS);
  const now = new Date();
  await db
    .update(schema.hrPortalAccess)
    .set({ status: 'active', lastLoginAt: now, updatedAt: now })
    .where(eq(schema.hrPortalAccess.id, access.id));
  await recordHrAudit(db, {
    actorId: `portal:${access.id}`,
    action: 'portal.signed_in',
    employeeId: access.employeeId,
    metadata: { kind: access.kind, companyId: access.companyId },
    ip: clientIp(c),
  });
  return { token, kind: session.kind, expiresIn: SESSION_TTL_SECONDS };
}

// ---------------------------------------------------------------------------
// Config + auth
// ---------------------------------------------------------------------------

app.get('/config', async (c) => {
  const settings = await enabledSettings(c);
  if (!settings) return c.json({ error: { code: 'NOT_FOUND', message: 'Portal is not enabled' } }, 404);
  return success(c, publicConfig(settings));
});

app.post('/auth/request', zValidator('json', hrPortalAuthRequestSchema), async (c) => {
  const settings = await enabledSettings(c);
  if (!settings) return c.json({ error: { code: 'NOT_FOUND', message: 'Portal is not enabled' } }, 404);
  const workspaceId = c.get('workspaceId');
  const email = normalizeEmail(c.req.valid('json').email);

  const rate = (await kvGetJson<{ count: number }>(c.env, kv.rate(workspaceId, email))) ?? { count: 0 };
  if (rate.count >= RATE_LIMIT_MAX) {
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } }, 429);
  }
  await kvPutJson(c.env, kv.rate(workspaceId, email), { count: rate.count + 1 }, RATE_LIMIT_TTL_SECONDS);

  const grants = (await grantsForEmail(c.get('tenantDb'), email)).filter((g) => kindEnabled(settings, g.kind));
  if (grants.length > 0) {
    const otp = randomOtp();
    const challenge: HrPortalChallenge = { workspaceId, email, otpHash: await sha256Hex(otp), attempts: 0 };
    await kvPutJson(c.env, kv.otp(workspaceId, email), challenge, OTP_TTL_SECONDS);
    c.executionCtx.waitUntil(sendHrPortalCodeEmail(c.env, { to: email, otp, settings }).then(() => undefined));
  }
  // Same answer either way — see the file header.
  return success(c, { ok: true });
});

app.post('/auth/verify', zValidator('json', hrPortalAuthVerifySchema), async (c) => {
  const settings = await enabledSettings(c);
  if (!settings) return c.json({ error: { code: 'NOT_FOUND', message: 'Portal is not enabled' } }, 404);
  const workspaceId = c.get('workspaceId');
  const { email: rawEmail, otp } = c.req.valid('json');
  const email = normalizeEmail(rawEmail);
  const key = kv.otp(workspaceId, email);

  const challenge = await kvGetJson<HrPortalChallenge>(c.env, key);
  if (!challenge) return error.unauthorized(c, 'That code has expired. Request a new one.');
  if (challenge.attempts >= MAX_OTP_ATTEMPTS) {
    await kvDelete(c.env, key);
    return error.unauthorized(c, 'Too many attempts. Request a new code.');
  }
  if ((await sha256Hex(otp.trim())) !== challenge.otpHash) {
    await kvPutJson(c.env, key, { ...challenge, attempts: challenge.attempts + 1 }, OTP_TTL_SECONDS);
    return error.unauthorized(c, 'That code is not right.');
  }
  await kvDelete(c.env, key);

  const grants = (await grantsForEmail(c.get('tenantDb'), email)).filter((g) => kindEnabled(settings, g.kind));
  if (grants.length === 0) return error.unauthorized(c, 'You no longer have access to this portal.');
  if (grants.length === 1) {
    return success(c, { session: await openSession(c, grants[0]!) });
  }

  // Several grants (e.g. an employee who is also a client contact, or a
  // contact at two client companies): let them pick.
  const pickerToken = randomToken();
  const picker: HrPortalPicker = { workspaceId, email, accessIds: grants.map((g) => g.id) };
  await kvPutJson(c.env, kv.picker(await sha256Hex(pickerToken)), picker, PICKER_TTL_SECONDS);
  return success(c, {
    pickerToken,
    options: grants.map((g) => ({ accessId: g.id, kind: g.kind, companyName: g.companyName, displayName: g.displayName })),
  });
});

app.post('/auth/select', zValidator('json', hrPortalSelectAccessSchema), async (c) => {
  const { pickerToken, accessId } = c.req.valid('json');
  const pickerKey = kv.picker(await sha256Hex(pickerToken));
  const picker = await kvGetJson<HrPortalPicker>(c.env, pickerKey);
  if (!picker || picker.workspaceId !== c.get('workspaceId') || !picker.accessIds.includes(accessId)) {
    return error.unauthorized(c, 'That sign-in has expired. Start again.');
  }
  const grants = await grantsForEmail(c.get('tenantDb'), picker.email);
  const grant = grants.find((g) => g.id === accessId);
  if (!grant) return error.unauthorized(c, 'You no longer have access to this portal.');
  await kvDelete(c.env, pickerKey);
  return success(c, { session: await openSession(c, grant) });
});

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

function readBearer(c: { req: { header: (k: string) => string | undefined } }): string | undefined {
  const header = c.req.header('Authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const cookie = c.req.header('Cookie');
  const match = cookie?.match(/(?:^|;\s*)hrportal_session=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

const requireSession = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const raw = readBearer(c);
  if (!raw) return error.unauthorized(c, 'Sign in required');
  const session = await kvGetJson<HrPortalSession>(c.env, kv.session(await sha256Hex(raw)));
  if (!session || session.workspaceId !== c.get('workspaceId')) return error.unauthorized(c, 'Session expired');

  const db = c.get('tenantDb');
  const settings = await loadPortalSettings(db);
  if (!settings.isEnabled || !kindEnabled(settings, session.kind)) {
    return error.unauthorized(c, 'The portal is not available right now');
  }

  const [access] = await db
    .select({ id: schema.hrPortalAccess.id, status: schema.hrPortalAccess.status })
    .from(schema.hrPortalAccess)
    .where(eq(schema.hrPortalAccess.id, session.accessId))
    .limit(1);
  if (!access || access.status === 'revoked') return error.unauthorized(c, 'Access revoked');

  if (session.kind === 'employee') {
    if (!session.employeeId) return error.unauthorized(c, 'Access revoked');
    const [employee] = await db
      .select({ status: schema.hrEmployees.status })
      .from(schema.hrEmployees)
      .where(and(eq(schema.hrEmployees.id, session.employeeId), isNull(schema.hrEmployees.deletedAt)))
      .limit(1);
    if (!employee || employee.status === 'terminated') return error.unauthorized(c, 'Access revoked');
  }

  c.set('hrPortalAccessId', session.accessId);
  c.set('hrPortalKind', session.kind);
  c.set('hrPortalEmployeeId', session.employeeId);
  c.set('hrPortalCompanyId', session.companyId);
  c.set('hrPortalEmail', session.email);
  c.set('hrPortalSessionToken', raw);
  await next();
});

const requireEmployee = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  if (c.get('hrPortalKind') !== 'employee' || !c.get('hrPortalEmployeeId')) {
    return error.forbidden(c, 'This page is for employees');
  }
  await next();
});

const requireClient = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  if (c.get('hrPortalKind') !== 'client' || !c.get('hrPortalCompanyId')) {
    return error.forbidden(c, 'This page is for clients');
  }
  await next();
});

function employeeIdOf(c: { get: (k: 'hrPortalEmployeeId') => string | null | undefined }): string {
  const id = c.get('hrPortalEmployeeId');
  if (!id) throw new Error('employee session without employee id');
  return id;
}

function companyIdOf(c: { get: (k: 'hrPortalCompanyId') => string | null | undefined }): string {
  const id = c.get('hrPortalCompanyId');
  if (!id) throw new Error('client session without company id');
  return id;
}

/** Portal-originated HR events: ids only, like every WeldHR event (see routes/weldhr/helpers.emit). */
function emitPortal<T extends Extract<EntityType, `hr_${string}`>>(
  c: PortalContext,
  entityType: T,
  action: ActionFor<T>,
  entityId: string,
  employeeId: string,
) {
  publishEntityEvent({ c, entityType, action, entityId, data: { id: entityId, employeeId } as DataFor<T>, source: 'web' });
  // The employee's other open portal tabs/devices, and client views the change touches.
  notifyPortal(c, { entity: entityType, action, id: entityId, employeeId });
}

app.use('/me', requireSession);
app.use('/auth/logout', requireSession);
app.use('/realtime/*', requireSession);

/**
 * Single-use ticket for the portal's live-update WebSocket. The browser opens
 * `${url}?token=${ticket}` within seconds; the realtime worker checks and
 * deletes the ticket, then joins the socket to this workspace's portal hub
 * with only this principal's topics allowed.
 */
app.get('/realtime/ticket', async (c) => {
  const accessId = c.get('hrPortalAccessId');
  const kind = c.get('hrPortalKind');
  const orgId = c.get('workspaceId');
  if (!accessId || !kind || !orgId) return error.unauthorized(c, 'Sign in required');
  const minted = await mintPortalRealtimeTicket(c.env, {
    orgId,
    accessId,
    kind,
    employeeId: c.get('hrPortalEmployeeId') ?? null,
    companyId: c.get('hrPortalCompanyId') ?? null,
  });
  if (!minted) return c.json({ error: { code: 'UNAVAILABLE', message: 'Live updates are not available' } }, 503);
  return success(c, minted);
});
app.use('/employee/*', requireSession, requireEmployee);
app.use('/client/*', requireSession, requireClient);

app.post('/auth/logout', async (c) => {
  const token = c.get('hrPortalSessionToken');
  if (token) await kvDelete(c.env, kv.session(await sha256Hex(token)));
  return noContent(c);
});

app.get('/me', async (c) => {
  const db = c.get('tenantDb');
  const settings = await loadPortalSettings(db);
  const kind = c.get('hrPortalKind');
  const base = { kind, email: c.get('hrPortalEmail'), config: publicConfig(settings) };
  if (kind === 'employee') {
    const profile = await employeeProfile(db, employeeIdOf(c));
    return success(c, { ...base, displayName: profile.displayName, employee: profile });
  }
  const companyId = companyIdOf(c);
  const [access] = await db
    .select({ displayName: schema.hrPortalAccess.displayName })
    .from(schema.hrPortalAccess)
    .where(eq(schema.hrPortalAccess.id, c.get('hrPortalAccessId') ?? ''))
    .limit(1);
  const names = await companyNames(db, [companyId]);
  return success(c, {
    ...base,
    displayName: access?.displayName ?? c.get('hrPortalEmail'),
    company: { id: companyId, name: names.get(companyId) ?? null },
  });
});

// ---------------------------------------------------------------------------
// Employee self-service
// ---------------------------------------------------------------------------

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

app.get('/employee/overview', async (c) => success(c, await employeeOverview(c.get('tenantDb'), employeeIdOf(c))));

app.get('/employee/attendance', async (c) => {
  const q = c.req.query();
  const to = q.to && isoDate.test(q.to) ? q.to : addDays(todayIso(), 14);
  const from = q.from && isoDate.test(q.from) ? q.from : addDays(todayIso(), -30);
  if (to < from || addDays(from, 92) < to) return error.badRequest(c, 'Pick a range of at most 92 days');
  return success(c, await employeeAttendance(c.get('tenantDb'), employeeIdOf(c), from, to));
});

app.post('/employee/clock', zValidator('json', hrPortalClockSchema), async (c) => {
  const settings = await loadPortalSettings(c.get('tenantDb'));
  if (!settings.employeeSelfClockIn) return error.forbidden(c, 'Clocking in from the portal is turned off');
  const employeeId = employeeIdOf(c);
  const { action } = c.req.valid('json');
  const record = await clock(c.get('tenantDb'), employeeId, action);
  emitPortal(c, 'hr_attendance', action === 'in' ? 'created' : 'updated', record.id, employeeId);
  return success(c, {
    id: record.id,
    date: record.date,
    clockIn: record.clockIn,
    clockOut: record.clockOut,
    status: record.status,
    workedMinutes: record.workedMinutes,
    lateMinutes: record.lateMinutes,
  });
});

app.get('/employee/leave', async (c) => success(c, await employeeLeave(c.get('tenantDb'), employeeIdOf(c))));

app.post('/employee/leave', zValidator('json', hrPortalLeaveRequestSchema), async (c) => {
  const settings = await loadPortalSettings(c.get('tenantDb'));
  if (!settings.employeeLeaveRequests) return error.forbidden(c, 'Leave requests from the portal are turned off');
  const employeeId = employeeIdOf(c);
  const row = await createLeaveRequest(c.get('tenantDb'), { ...c.req.valid('json'), employeeId }, `portal:${employeeId}`);
  emitPortal(c, 'hr_leave_request', row.status === 'approved' ? 'approved' : 'created', row.id, employeeId);
  return success(c, row, 201);
});

app.post('/employee/leave/:leaveRequestId/cancel', async (c) => {
  const employeeId = employeeIdOf(c);
  const row = await cancelLeaveRequest(c.get('tenantDb'), c.req.param('leaveRequestId'), employeeId);
  emitPortal(c, 'hr_leave_request', 'updated', row.id, employeeId);
  return success(c, row);
});

app.get('/employee/coaching', async (c) => success(c, await employeeCoaching(c.get('tenantDb'), employeeIdOf(c))));

app.post('/employee/coaching/:coachingId/acknowledge', zValidator('json', hrPortalAcknowledgeSchema), async (c) => {
  const employeeId = employeeIdOf(c);
  const row = await acknowledgeCoachingLog(c.get('tenantDb'), c.req.param('coachingId'), employeeId, c.req.valid('json').comment);
  emitPortal(c, 'hr_coaching_log', 'acknowledged', row.id, employeeId);
  return success(c, { id: row.id, acknowledgedAt: row.acknowledgedAt, status: row.status });
});

app.get('/employee/evaluations', async (c) => success(c, await employeeEvaluations(c.get('tenantDb'), employeeIdOf(c))));

app.post('/employee/evaluations/:evaluationId/acknowledge', zValidator('json', hrPortalAcknowledgeSchema), async (c) => {
  const employeeId = employeeIdOf(c);
  const row = await acknowledgeEvaluation(c.get('tenantDb'), c.req.param('evaluationId'), employeeId, c.req.valid('json').comment);
  emitPortal(c, 'hr_evaluation', 'acknowledged', row.id, employeeId);
  return success(c, { id: row.id, acknowledgedAt: row.acknowledgedAt, status: row.status });
});

app.get('/employee/tasks', async (c) => success(c, await employeeTasks(c.get('tenantDb'), employeeIdOf(c))));

app.post('/employee/tasks/:taskId/complete', async (c) => {
  const employeeId = employeeIdOf(c);
  const done = c.req.query('undo') !== 'true';
  const { checklistId, outcome } = await completeEmployeeTask(c.get('tenantDb'), employeeId, c.req.param('taskId'), done);
  emitPortal(c, 'hr_checklist', outcome.checklistCompleted ? 'completed' : 'updated', checklistId, employeeId);
  if (outcome.employeeStatus === 'active') emitPortal(c, 'hr_employee', 'onboarded', employeeId, employeeId);
  return success(c, { ok: true, checklistCompleted: outcome.checklistCompleted });
});

app.get('/employee/performance', async (c) => success(c, await employeePerformance(c.get('tenantDb'), employeeIdOf(c))));

// ---------------------------------------------------------------------------
// Client view
// ---------------------------------------------------------------------------

app.get('/client/overview', async (c) => {
  const db = c.get('tenantDb');
  const settings = await loadPortalSettings(db);
  return success(c, await buildClientView(db, companyIdOf(c), { individualScores: settings.clientCanSeeIndividualScores }));
});

/** One team member, as the client may see them. 404 unless currently on this client's account. */
app.get('/client/team/:employeeId', async (c) => {
  const db = c.get('tenantDb');
  const companyId = companyIdOf(c);
  const employeeId = c.req.param('employeeId');
  const team = await clientTeam(db, companyId);
  const member = team.find((m) => m.employeeId === employeeId);
  if (!member) return error.notFound(c, 'Team member', employeeId);

  const settings = await loadPortalSettings(db);
  const since = addDays(todayIso(), -365);
  const [milestones, evaluations, kpis] = await Promise.all([
    listMilestones(db, { employeeId, sharedWithClient: true }),
    settings.clientCanSeeIndividualScores
      ? listEvaluations(db, { employeeId, sharedWithClient: true, status: 'submitted,acknowledged', from: since })
      : Promise.resolve([]),
    settings.clientCanSeeIndividualScores
      ? listKpiValues(db, { employeeId, sharedWithClient: true, from: since })
      : Promise.resolve([]),
  ]);
  const onAccount = <T extends { companyId: string | null }>(rows: T[]) =>
    rows.filter((r) => r.companyId === null || r.companyId === companyId);

  return success(c, {
    member,
    milestones: onAccount(milestones).map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      type: m.type,
      status: m.status,
      dueDate: m.dueDate,
      achievedAt: m.achievedAt,
    })),
    evaluations: onAccount(evaluations).map((e) => ({
      id: e.id,
      formName: e.formName,
      periodStart: e.periodStart,
      periodEnd: e.periodEnd,
      overallScore: e.overallScore,
      summary: e.summary,
      submittedAt: e.submittedAt,
    })),
    kpis: onAccount(kpis).map((k) => ({
      id: k.id,
      kpiName: k.kpiName,
      unit: k.unit,
      direction: k.direction,
      target: k.target,
      value: k.value,
      onTarget: k.onTarget,
      periodStart: k.periodStart,
      periodEnd: k.periodEnd,
    })),
  });
});

app.get('/client/requests', async (c) => {
  return success(c, await clientRequests(c.get('tenantDb'), c.get('hrPortalEmail') ?? ''));
});

app.post('/client/requests', zValidator('json', hrPortalClientRequestSchema), async (c) => {
  const db = c.get('tenantDb');
  const companyId = companyIdOf(c);
  const [access] = await db
    .select({ personId: schema.hrPortalAccess.personId, displayName: schema.hrPortalAccess.displayName })
    .from(schema.hrPortalAccess)
    .where(eq(schema.hrPortalAccess.id, c.get('hrPortalAccessId') ?? ''))
    .limit(1);
  const names = await companyNames(db, [companyId]);
  const input = c.req.valid('json');
  const ticket = await createClientRequest(db, {
    personId: access?.personId ?? null,
    companyName: names.get(companyId) ?? null,
    email: c.get('hrPortalEmail') ?? '',
    displayName: access?.displayName ?? null,
    subject: input.subject,
    message: input.message,
  });
  publishEntityEvent({
    c,
    entityType: 'ticket',
    entityId: ticket.id,
    action: 'created',
    data: { id: ticket.id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, status: ticket.status, contactId: access?.personId ?? null },
  });
  return success(c, ticket, 201);
});

export { app as publicHrPortalRoutes };
