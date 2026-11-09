/**
 * Public routes — /public/forms/*, called only by apps/web/forms-portal.
 *
 * Every request carries the portal's key in `X-Forms-Portal-Key`
 * (`FORMS_PORTAL_SECRET`, constant-time compared; 503 while the secret is unset,
 * 403 when it is wrong), and the respondent's address in `X-Respondent-Ip`,
 * trusted only next to the key (the FE-017 contract). Respondents never reach
 * this mount directly (ADR FORMS-002). A respondent's IP is only ever kept as a
 * keyed hash.
 *
 *   GET  /f/:publicId             → the published form, state and bot-check settings (from the cache)
 *   POST /f/:publicId/view        → counts a view (counter store, no tenant DB)
 *   POST /f/:publicId/sessions    → starts or resumes a response: bot check, invitation or verified email
 *   POST /f/:publicId/send-code   → emails a 6-digit code (verified-email forms)
 *   POST /f/:publicId/verify      → checks the code, answers a verification token
 *   POST /f/:publicId/report      → an abuse report (master registry)
 *   PUT  /sessions/progress       → saves progress (and answers when the form collects partials)
 *   POST /sessions/uploads        → a file or a signature for one field
 *   POST /sessions/submit         → the final answers, validated by the engine
 *   GET  /altcha/challenge        → a proof-of-work challenge (BOT_CHECK_PROVIDER=altcha)
 *
 * Session routes take `Authorization: Bearer <session>` from `POST …/sessions`.
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { secretMatches } from '@weldsuite/worker-kit';
import { getMasterDb, masterSchema, schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { success } from '@weldsuite/worker-kit/response';
import { eq } from 'drizzle-orm';
import {
  FORMS_PORTAL_HEADERS,
  FORM_LIMITS,
  recordViewSchema,
  reportAbuseSchema,
  saveProgressSchema,
  sendCodeSchema,
  startSessionSchema,
  submitSessionSchema,
  verifyCodeSchema,
} from '@weldsuite/app-api-client/schemas/weldforms';
import { countersFor, type FormCountersPort } from '../../lib/counters';
import { FormsError, handle } from '../../lib/errors';
import { createAltchaChallenge, passesBotCheck } from '../../services/bot-check';
import { checkCode, sendCode } from '../../services/codes';
import { openWorkspace, closedError, loadEntry, loadVersion, resolveLink, stateOf, toPublicForm, type LinkRow } from '../../services/public-form';
import { rateLimited, saveProgress, startSession, uploadFile } from '../../services/respondent';
import {
  dropSeed,
  issueVerification,
  keyedHash,
  readSeed,
  requireSession,
  sessionSecret,
  type RespondentSession,
} from '../../services/sessions';
import { submitResponse } from '../../services/submit';
import type { WorkspaceCtx } from '../../services/context';
import type { Env, Variables } from '../../types';

const { formAbuseReports } = masterSchema;
const { forms, formResponses } = schema;

type PublicVariables = Variables & { respondentIp: string | null; respondentCountry: string | null };
type PublicContext = import('hono').Context<{ Bindings: Env; Variables: PublicVariables }>;

const app = new Hono<{ Bindings: Env; Variables: PublicVariables }>();

/** Submissions one form takes per minute, over all respondents. */
const SUBMITS_PER_FORM_PER_MINUTE = 120;
const CODES_PER_IP_PER_MINUTE = 5;
const REPORTS_PER_IP_PER_MINUTE = 5;

const guard = createMiddleware<{ Bindings: Env; Variables: PublicVariables }>(async (c, next) => {
  const secret = c.env.FORMS_PORTAL_SECRET;
  if (!secret) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The forms portal is not configured on this deployment.' } }, 503);
  if (!secretMatches(c.req.header(FORMS_PORTAL_HEADERS.key), secret)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
  }
  c.set('respondentIp', c.req.header(FORMS_PORTAL_HEADERS.ip)?.trim() || null);
  c.set('respondentCountry', c.req.header(FORMS_PORTAL_HEADERS.country)?.trim().toUpperCase().slice(0, 2) || null);
  await next();
});
app.use('*', guard);

const today = () => new Date().toISOString().slice(0, 10);

async function ipHashOf(c: PublicContext): Promise<string | null> {
  const ip = c.get('respondentIp');
  return ip ? keyedHash(c.env, 'ip', ip) : null;
}

/** A session's link and workspace; a form staff stopped (suspended, held) ends its sessions too. */
async function sessionContext(c: PublicContext): Promise<{ session: RespondentSession; link: LinkRow; ctx: WorkspaceCtx; counters: FormCountersPort }> {
  const session = await requireSession(c.env, c.req.header('Authorization'));
  const link = await resolveLink(getMasterDb(c.env), session.pub);
  if (link.formId !== session.form || link.workspaceId !== session.ws) throw new FormsError(401, 'UNAUTHORIZED', 'Your session has expired. Open the form again.');
  if (link.suspendedAt) throw closedError('suspended');
  if (link.heldAt) throw closedError('held');
  return { session, link, ctx: await openWorkspace(c.env, link), counters: countersFor(c.env.FORM_COUNTERS, link.formId) };
}

// ── Proof-of-work challenge ──────────────────────────────────────────────────

app.get('/altcha/challenge', (c) =>
  handle(c, async () => {
    const challenge = await createAltchaChallenge(c.env);
    if (!challenge) throw new FormsError(503, 'SERVICE_UNAVAILABLE', 'The bot check is not configured.');
    return c.json(challenge);
  }),
);

// ── The form ─────────────────────────────────────────────────────────────────

app.get('/f/:publicId', (c) =>
  handle(c, async () => {
    const link = await resolveLink(getMasterDb(c.env), c.req.param('publicId'));
    const { entry, ctx } = await loadEntry(c.env, link);
    // A respondent finishing an older version asks for it by id (the one their response was started on).
    const versionId = c.req.query('versionId');
    let version: { id: string; definition: unknown } | null = null;
    if (versionId && versionId !== entry.versionId) {
      const open = ctx ?? (await openWorkspace(c.env, link));
      const row = await loadVersion(open, link.formId, versionId);
      version = { id: row.id, definition: row.definition };
    }
    return success(c, toPublicForm(c.env, link, entry, { version }));
  }),
);

app.post('/f/:publicId/view', zValidator('json', recordViewSchema), (c) =>
  handle(c, async () => {
    const link = await resolveLink(getMasterDb(c.env), c.req.param('publicId'));
    const counted = await countersFor(c.env.FORM_COUNTERS, link.formId).recordView(today(), c.req.valid('json').viewKey);
    return success(c, { counted });
  }),
);

// ── Sessions ─────────────────────────────────────────────────────────────────

app.post('/f/:publicId/sessions', zValidator('json', startSessionSchema), (c) =>
  handle(c, async () => {
    sessionSecret(c.env);
    const link = await resolveLink(getMasterDb(c.env), c.req.param('publicId'));
    const { entry, ctx } = await loadEntry(c.env, link);
    const result = await startSession({
      env: c.env,
      link,
      entry,
      counters: countersFor(c.env.FORM_COUNTERS, link.formId),
      input: c.req.valid('json'),
      ip: c.get('respondentIp'),
      country: c.get('respondentCountry'),
      open: async () => ctx ?? openWorkspace(c.env, link),
    });
    return success(c, result, 201);
  }),
);

app.post('/f/:publicId/send-code', zValidator('json', sendCodeSchema), (c) =>
  handle(c, async () => {
    sessionSecret(c.env);
    const link = await resolveLink(getMasterDb(c.env), c.req.param('publicId'));
    const { entry } = await loadEntry(c.env, link);
    const state = stateOf(link, entry);
    if (state !== 'open') throw closedError(state);
    if (entry.settings.respondentMode !== 'verified_email') throw new FormsError(400, 'BAD_REQUEST', 'This form does not ask for a verified email.');
    const counters = countersFor(c.env.FORM_COUNTERS, link.formId);
    await rateLimited(counters, `code:${(await ipHashOf(c)) ?? 'unknown'}`, CODES_PER_IP_PER_MINUTE);
    const input = c.req.valid('json');
    // Without it anyone could make a workspace's form mail strangers.
    if (!(await passesBotCheck(c.env, input.botToken, c.get('respondentIp')))) {
      throw new FormsError(403, 'BOT_CHECK_FAILED', 'The bot check failed. Reload the page and try again.');
    }
    return success(c, await sendCode(c.env, counters, entry, input.email, link.clerkOrgId));
  }),
);

app.post('/f/:publicId/verify', zValidator('json', verifyCodeSchema), (c) =>
  handle(c, async () => {
    sessionSecret(c.env);
    const link = await resolveLink(getMasterDb(c.env), c.req.param('publicId'));
    const { entry } = await loadEntry(c.env, link);
    if (entry.settings.respondentMode !== 'verified_email') throw new FormsError(400, 'BAD_REQUEST', 'This form does not ask for a verified email.');
    const input = c.req.valid('json');
    await checkCode(c.env, countersFor(c.env.FORM_COUNTERS, link.formId), link.formId, input.email, input.code);
    return success(c, { verification: await issueVerification(c.env, link.formId, input.email.trim().toLowerCase()) });
  }),
);

app.post('/f/:publicId/report', zValidator('json', reportAbuseSchema), (c) =>
  handle(c, async () => {
    const master = getMasterDb(c.env);
    const link = await resolveLink(master, c.req.param('publicId'));
    const ipHash = await ipHashOf(c).catch(() => null);
    await rateLimited(countersFor(c.env.FORM_COUNTERS, link.formId), `report:${ipHash ?? 'unknown'}`, REPORTS_PER_IP_PER_MINUTE);
    const input = c.req.valid('json');
    await master.insert(formAbuseReports).values({
      id: generateId('fab'),
      publicId: link.publicId,
      workspaceId: link.workspaceId,
      formId: link.formId,
      reason: input.reason,
      details: input.details ?? null,
      reporterEmail: input.email ?? null,
      reporterIpHash: ipHash,
    });
    return success(c, { received: true }, 201);
  }),
);

// ── Session routes ───────────────────────────────────────────────────────────

app.put('/sessions/progress', zValidator('json', saveProgressSchema), (c) =>
  handle(c, async () => {
    const { session, link, ctx } = await sessionContext(c);
    const { entry } = await loadEntry(c.env, link, ctx);
    await saveProgress({ env: c.env, ctx, session, entry, input: c.req.valid('json') });
    return success(c, { saved: true });
  }),
);

app.post('/sessions/uploads', (c) =>
  handle(c, async () => {
    const { session, ctx, counters } = await sessionContext(c);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new FormsError(400, 'BAD_REQUEST', 'Send the file as multipart form data.');
    }
    const blockId = form.get('blockId');
    const file = form.get('file');
    if (typeof blockId !== 'string' || !file || typeof file === 'string') throw new FormsError(400, 'BAD_REQUEST', 'Send "blockId" and "file".');
    return success(c, { file: await uploadFile({ env: c.env, ctx, session, counters, blockId, file }) }, 201);
  }),
);

app.post('/sessions/submit', zValidator('json', submitSessionSchema), (c) =>
  handle(c, async () => {
    const { session, ctx, counters } = await sessionContext(c);
    const input = c.req.valid('json');
    await rateLimited(counters, 'submit', SUBMITS_PER_FORM_PER_MINUTE);
    // A hidden input real people leave empty.
    if (input.website) throw new FormsError(400, 'SUBMISSION_REJECTED', 'The submission was rejected.');

    const [form] = await ctx.db.select().from(forms).where(eq(forms.id, session.form)).limit(1);
    if (!form) throw new FormsError(404, 'NOT_FOUND', 'Form not found');
    const [existing] = await ctx.db.select().from(formResponses).where(eq(formResponses.id, session.resp)).limit(1);
    const seed = await readSeed(c.env.WORKSPACE_CACHE, session.resp);

    // Too quick to be a person: less than a moment between start and submit.
    const startedAt = existing?.startedAt.getTime() ?? seed?.startedAt;
    const minFill = Number(c.env.FORMS_MIN_FILL_MS ?? FORM_LIMITS.minFillMs);
    if (existing?.status !== 'completed' && startedAt !== undefined && Date.now() - startedAt < minFill) {
      throw new FormsError(400, 'SUBMISSION_REJECTED', 'The submission was rejected.');
    }

    const version = await loadVersion(ctx, form.id, session.ver);
    const outcome = await submitResponse({
      ctx,
      form,
      version,
      responseId: session.resp,
      answers: input.answers,
      hidden: existing?.hidden ?? seed?.hidden ?? {},
      timings: input.timings,
      identity: { email: session.email ?? null, userId: null, hash: existing?.respondentHash ?? seed?.browserHash ?? null, invitationId: session.inv ?? existing?.invitationId ?? null },
      seed: seed ?? (existing ? { metadata: existing.metadata, ipHash: existing.ipHash, startedAt: existing.startedAt.getTime() } : null),
      actor: 'respondent',
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    });
    c.executionCtx.waitUntil(dropSeed(c.env.WORKSPACE_CACHE, session.resp));
    return success(c, outcome.result);
  }),
);

export default app;
