/**
 * Signer portal API — /public/sign-portal/* (ADR SIGN-002). Called only by
 * apps/web/sign-portal's server, through app-api's forwarder. No Clerk: a
 * signing link opens a signer session (HMAC, `services/session.ts`), which
 * the portal sends as a bearer token.
 *
 *   POST /session      { token }        → ready (session) | code_required | closed; 404 unknown link
 *   POST /verify       { token, code }  → ready; 400 INVALID_CODE, 429 LOCKED
 *   POST /resend-code  { token }        → a new emailed code; 429 when asked too often
 *   GET  /envelope                      → what this signer sees
 *   GET  /documents/:documentId         → the PDF with earlier signers' values drawn in
 *   POST /consent      { disclosureVersion }
 *   POST /complete     { values, signature, initials, timeZone }
 *                                      → 503 when the last signature could not start finalizing; again retries
 *   POST /decline      { reason }
 *   GET  /download                      → the signed PDF (completed requests)
 *
 * Writes publish `sign_envelope` events (`signed`, `declined`); the evidence
 * of each step is `sign_events`, with the signer's IP (as the portal reports
 * it, next to `X-Sign-Portal-Key`) and browser.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { error, success } from '@weldsuite/worker-kit/response';
import { secretMatches } from '@weldsuite/worker-kit/webhook-token';
import { getMasterDb, getWorkspaceContextForOrg, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import {
  portalCompleteSchema,
  portalConsentSchema,
  portalDeclineSchema,
  portalSessionSchema,
  portalVerifySchema,
  type SignPortalSessionResponse,
} from '@weldsuite/app-api-client/schemas/weldsign';
import type { Env, Variables } from '../../types';
import { SignError } from '../../services/errors';
import { resolveLink, resolveLinkByHash, revokeEnvelopeLinks, type ResolvedLink } from '../../services/links';
import { signSession, verifySession, type SignerSession } from '../../services/session';
import { checkCode, emailCodeHash, emailHint, isLocked, issueEmailCode, newEmailCode, CODE_TTL_SECONDS } from '../../services/codes';
import { codeAttemptsFor } from '../../durable-objects/code-attempts';
import {
  closedReason,
  completeSigning,
  declineSigning,
  loadSigner,
  markOpened,
  portalMode,
  portalView,
  recordCodeCheck,
  recordConsent,
  signerDocument,
  type SignerMeta,
  type SignerRef,
} from '../../services/signing';
import { advanceAfterSigning, awaitingFinalize } from '../../services/sending';
import { loadSignBrand } from '../../services/settings';
import { sendCode, sendDeclined, workspaceBrand } from '../../services/mail';
import { codeHash } from '../../services/hash';
import { finalizeEnvelope, type FinalizeEnvelopeParams } from '../../workflows/finalize-envelope';

export interface PortalWorkspace {
  /** Master `workspaces.id`. */
  id: string;
  db: Database;
  suspended: boolean;
}

/** Seams for tests: the master DB and the tenant DB of an org. */
export interface PortalDeps {
  master: (env: Env) => MasterDatabase;
  workspace: (env: Env, clerkOrgId: string) => Promise<PortalWorkspace>;
  finalize: (env: Env, params: FinalizeEnvelopeParams) => Promise<void>;
}

const defaultDeps: PortalDeps = {
  master: (env) => getMasterDb(env),
  workspace: (env, orgId) => getWorkspaceContextForOrg(env, orgId),
  finalize: finalizeEnvelope,
};

interface SignerVars {
  signer: SignerSession;
  workspace: PortalWorkspace;
}

type PortalEnv = { Bindings: Env; Variables: Variables & SignerVars };
type PortalCtx = Context<PortalEnv>;

/**
 * The signer's IP and browser for the evidence trail. sign-portal reports the
 * browser's IP in `X-Signer-Ip`, which counts only next to the shared portal
 * key: anyone else could put any address there, so their own is recorded.
 */
function meta(c: Context): SignerMeta {
  const env: Env = c.env;
  const reported = secretMatches(c.req.header('x-sign-portal-key'), env.SIGN_PORTAL_SECRET) ? c.req.header('x-signer-ip') : undefined;
  return {
    ip: reported ?? c.req.header('cf-connecting-ip') ?? null,
    userAgent: c.req.header('user-agent')?.slice(0, 500) ?? null,
  };
}

/** Codes are compared in their keyed, recipient-bound form (services/hash.ts `codeHash`). */
function hasherFor(env: Env, recipientId: string) {
  return (code: string) => codeHash(env.SIGN_SESSION_SECRET!, recipientId, code);
}

function codeError(c: Context, status: 400 | 429, code: string, message: string, details?: Record<string, unknown>) {
  return c.json({ error: { code, message, ...(details ? { details } : {}) } }, status);
}

function respond(c: Context, err: unknown): Response {
  if (!(err instanceof SignError)) throw err;
  if (err.kind === 'not_found') return error.notFound(c, err.resource ?? 'Resource');
  if (err.kind === 'conflict') return error.conflict(c, err.message);
  return error.badRequest(c, err.message);
}

export function createSignPortalRoutes(overrides: Partial<PortalDeps> = {}) {
  const deps: PortalDeps = { ...defaultDeps, ...overrides };
  const app = new Hono<PortalEnv>();

  /** The workspace and signer a link points at; null for anything a signer must not learn more about. */
  async function open(env: Env, token: string): Promise<{ link: ResolvedLink; workspace: PortalWorkspace; ref: SignerRef } | null> {
    const link = await resolveLink(deps.master(env), token);
    if (!link) return null;
    let workspace: PortalWorkspace;
    try {
      workspace = await deps.workspace(env, link.clerkOrgId);
    } catch {
      return null;
    }
    if (workspace.suspended) return null;
    try {
      return { link, workspace, ref: await loadSigner(workspace.db, link.envelopeId, link.recipientId) };
    } catch (err) {
      if (err instanceof SignError) return null;
      throw err;
    }
  }

  /**
   * Start the Workflow that builds the signed PDF. Its instance id is fixed per
   * request, so a second start finds the first: one still running or done is
   * left alone, one that failed is restarted. Throws when it could not start.
   */
  async function startFinalizing(c: Context, params: FinalizeEnvelopeParams): Promise<void> {
    const env: Env = c.env;
    const workflow = env.FINALIZE_ENVELOPE;
    if (!workflow) {
      c.executionCtx.waitUntil(deps.finalize(env, params));
      return;
    }
    const id = `finalize-${params.envelopeId}`;
    try {
      await workflow.create({ id, params });
    } catch (err) {
      const instance = await workflow.get(id).catch(() => null);
      if (!instance) throw err;
      const { status } = await instance.status();
      if (status === 'errored' || status === 'terminated') await instance.restart();
    }
  }

  async function ready(c: Context, opened: { link: ResolvedLink; workspace: PortalWorkspace; ref: SignerRef }) {
    await markOpened(opened.workspace.db, opened.ref, meta(c));
    // Everyone signed but finalizing never got going: reopening any link of the request starts it again.
    if (await awaitingFinalize(opened.workspace.db, opened.ref.envelope)) {
      const params: FinalizeEnvelopeParams = { clerkOrgId: opened.link.clerkOrgId, workspaceId: opened.workspace.id, envelopeId: opened.link.envelopeId };
      c.executionCtx.waitUntil(
        startFinalizing(c, params).catch((err: unknown) => console.error(`[sign-api] could not start finalizing ${params.envelopeId}:`, err)),
      );
    }
    const { token, expiresAt } = await signSession(c.env.SIGN_SESSION_SECRET!, {
      orgId: opened.link.clerkOrgId,
      envelopeId: opened.link.envelopeId,
      recipientId: opened.link.recipientId,
      tokenHash: opened.link.tokenHash,
    });
    const body: SignPortalSessionResponse = { state: 'ready', session: token, expiresAt: expiresAt.toISOString() };
    return success(c, body);
  }

  const needsSecret: MiddlewareHandler<PortalEnv> = async (c, next) => {
    if (!c.env.SIGN_SESSION_SECRET) return error.unavailable(c, 'Signing is not configured');
    await next();
  };
  app.use('*', needsSecret);

  app.post('/session', zValidator('json', portalSessionSchema), async (c) => {
    const opened = await open(c.env, c.req.valid('json').token);
    if (!opened) return error.notFound(c, 'Signing link');
    const reason = closedReason(opened.ref.envelope);
    if (reason) return success(c, { state: 'closed', reason } satisfies SignPortalSessionResponse);
    const { recipient } = opened.ref;
    if (recipient.authMode === 'link' || recipient.role === 'cc') return ready(c, opened);

    const kv = c.env.WORKSPACE_CACHE;
    if (await isLocked(codeAttemptsFor(c.env.SIGN_CODE_ATTEMPTS, opened.link.tokenHash))) return codeError(c, 429, 'LOCKED', 'Too many wrong codes. Try again later.');
    if (recipient.authMode === 'email_code') {
      const code = newEmailCode();
      if (await issueEmailCode(kv, opened.link.tokenHash, code, hasherFor(c.env, recipient.id))) {
        await sendCode(
          { env: c.env, db: opened.workspace.db, clerkOrgId: opened.link.clerkOrgId, envelope: opened.ref.envelope, master: deps.master(c.env) },
          recipient,
          code,
          CODE_TTL_SECONDS / 60,
        );
      }
    }
    return success(c, {
      state: 'code_required',
      method: recipient.authMode === 'email_code' ? 'email_code' : 'access_code',
      emailHint: recipient.authMode === 'email_code' ? emailHint(recipient.email) : null,
    } satisfies SignPortalSessionResponse);
  });

  app.post('/verify', zValidator('json', portalVerifySchema), async (c) => {
    const { token, code } = c.req.valid('json');
    const opened = await open(c.env, token);
    if (!opened) return error.notFound(c, 'Signing link');
    const reason = closedReason(opened.ref.envelope);
    if (reason) return success(c, { state: 'closed', reason } satisfies SignPortalSessionResponse);
    const { recipient } = opened.ref;
    if (recipient.authMode === 'link') return ready(c, opened);
    const kv = c.env.WORKSPACE_CACHE;
    const expected = recipient.authMode === 'email_code' ? await emailCodeHash(kv, opened.link.tokenHash) : recipient.accessCodeHash;
    const result = await checkCode(
      kv,
      codeAttemptsFor(c.env.SIGN_CODE_ATTEMPTS, opened.link.tokenHash),
      opened.link.tokenHash,
      expected,
      code,
      hasherFor(c.env, recipient.id),
    );
    await recordCodeCheck(opened.workspace.db, opened.ref, result.ok, meta(c));
    if (!result.ok) {
      return result.locked
        ? codeError(c, 429, 'LOCKED', 'Too many wrong codes. Try again later.')
        : codeError(c, 400, 'INVALID_CODE', 'That code is not correct', { attemptsLeft: result.attemptsLeft });
    }
    return ready(c, opened);
  });

  app.post('/resend-code', zValidator('json', portalSessionSchema), async (c) => {
    const opened = await open(c.env, c.req.valid('json').token);
    if (!opened) return error.notFound(c, 'Signing link');
    const { recipient, envelope } = opened.ref;
    if (recipient.authMode !== 'email_code' || closedReason(envelope)) return error.conflict(c, 'No code to send');
    const kv = c.env.WORKSPACE_CACHE;
    if (await isLocked(codeAttemptsFor(c.env.SIGN_CODE_ATTEMPTS, opened.link.tokenHash))) return codeError(c, 429, 'LOCKED', 'Too many wrong codes. Try again later.');
    const code = newEmailCode();
    if (!(await issueEmailCode(kv, opened.link.tokenHash, code, hasherFor(c.env, recipient.id)))) {
      return codeError(c, 429, 'TOO_SOON', 'A code was sent a moment ago');
    }
    await sendCode({ env: c.env, db: opened.workspace.db, clerkOrgId: opened.link.clerkOrgId, envelope, master: deps.master(c.env) }, recipient, code, CODE_TTL_SECONDS / 60);
    return success(c, { sent: true });
  });

  // ── Signer session routes ────────────────────────────────────────────────
  const signer = new Hono<PortalEnv>();
  signer.use('*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = token ? await verifySession(c.env.SIGN_SESSION_SECRET!, token) : null;
    if (!session) return error.unauthorized(c, 'Your session has expired. Open the link again.');
    // A session lasts only as long as its link: a corrected email, void or decline revokes the link.
    const link = await resolveLinkByHash(deps.master(c.env), session.tokenHash);
    if (!link || link.envelopeId !== session.envelopeId || link.recipientId !== session.recipientId || link.clerkOrgId !== session.orgId) {
      return error.unauthorized(c, 'Your session has expired. Open the link again.');
    }
    let workspace: PortalWorkspace;
    try {
      workspace = await deps.workspace(c.env, session.orgId);
    } catch {
      return error.notFound(c, 'Envelope');
    }
    if (workspace.suspended) return error.notFound(c, 'Envelope');
    c.set('signer', session);
    c.set('workspace', workspace);
    await next();
  });

  const current = (c: PortalCtx) => loadSigner(c.get('workspace').db, c.get('signer').envelopeId, c.get('signer').recipientId);

  async function view(c: PortalCtx, ref: SignerRef) {
    const db = c.get('workspace').db;
    const brand = await loadSignBrand(db);
    const name = brand.name ?? (await workspaceBrand({ env: c.env, db, clerkOrgId: c.get('signer').orgId, master: deps.master(c.env) })).name;
    return portalView(db, ref, { name, color: brand.color, logoUrl: brand.logoUrl });
  }

  signer.get('/envelope', async (c) => {
    try {
      return success(c, await view(c, await current(c)));
    } catch (err) {
      return respond(c, err);
    }
  });

  signer.get('/documents/:documentId', async (c) => {
    try {
      const ref = await current(c);
      if (portalMode(ref.envelope, ref.recipient) === 'closed') return error.conflict(c, 'This request is closed');
      const object = await signerDocument(c.get('workspace').db, c.env.PRIVATE_STORAGE, ref.envelope.id, c.req.param('documentId'));
      return new Response(object.body, {
        headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    } catch (err) {
      return respond(c, err);
    }
  });

  signer.post('/consent', zValidator('json', portalConsentSchema), async (c) => {
    try {
      await recordConsent(c.get('workspace').db, await current(c), c.req.valid('json').disclosureVersion, meta(c));
      return success(c, { consented: true });
    } catch (err) {
      return respond(c, err);
    }
  });

  /**
   * After the last signature: start finalizing. When it cannot start, the
   * signer hears so (503) while their signature stays saved, and finishing
   * again retries the start.
   */
  async function finish(c: PortalCtx, params: FinalizeEnvelopeParams) {
    try {
      await startFinalizing(c, params);
    } catch (err) {
      console.error(`[sign-api] could not start finalizing ${params.envelopeId}:`, err);
      return error.unavailable(c, 'Your signature is saved, but the request could not be completed yet. Try again in a moment.');
    }
    return success(c, await view(c, await current(c)));
  }

  signer.post('/complete', zValidator('json', portalCompleteSchema), async (c) => {
    try {
      const { db, id: workspaceId } = c.get('workspace');
      const session = c.get('signer');
      const ref = await current(c);
      const params: FinalizeEnvelopeParams = { clerkOrgId: session.orgId, workspaceId, envelopeId: ref.envelope.id };
      // A retry after finalizing could not start: the signature is already saved.
      if (ref.recipient.status === 'signed' && (await awaitingFinalize(db, ref.envelope))) return await finish(c, params);
      await completeSigning({ db, bucket: c.env.PRIVATE_STORAGE, workspaceId: session.orgId, meta: meta(c) }, ref, c.req.valid('json'));
      c.executionCtx.waitUntil(
        publishEntityEventRaw({
          env: c.env,
          workspaceId: session.orgId,
          userId: 'system',
          source: 'api',
          entityType: 'sign_envelope',
          action: 'signed',
          entityId: ref.envelope.id,
          data: { id: ref.envelope.id, title: ref.envelope.title, status: ref.envelope.status },
        }),
      );
      const next = await advanceAfterSigning(
        { env: c.env, db, master: deps.master(c.env), clerkOrgId: session.orgId, workspaceId },
        ref.envelope,
      );
      if (next === 'all_signed') return await finish(c, params);
      return success(c, await view(c, await current(c)));
    } catch (err) {
      return respond(c, err);
    }
  });

  signer.post('/decline', zValidator('json', portalDeclineSchema), async (c) => {
    try {
      const { db, id: workspaceId } = c.get('workspace');
      const session = c.get('signer');
      const ref = await current(c);
      const { reason } = c.req.valid('json');
      await declineSigning(db, ref, reason, meta(c));
      await revokeEnvelopeLinks(deps.master(c.env), workspaceId, ref.envelope.id);
      c.executionCtx.waitUntil(
        Promise.all([
          sendDeclined({ env: c.env, db, clerkOrgId: session.orgId, envelope: ref.envelope, master: deps.master(c.env) }, ref.recipient.name || ref.recipient.email || '', reason, null),
          publishEntityEventRaw({
            env: c.env,
            workspaceId: session.orgId,
            userId: 'system',
            source: 'api',
            entityType: 'sign_envelope',
            action: 'declined',
            entityId: ref.envelope.id,
            data: { id: ref.envelope.id, title: ref.envelope.title, status: 'declined' },
          }),
        ]),
      );
      return success(c, await view(c, await current(c)));
    } catch (err) {
      return respond(c, err);
    }
  });

  signer.get('/download', async (c) => {
    try {
      const { envelope } = await current(c);
      if (envelope.status !== 'completed' || !envelope.finalStorageKey) return error.conflict(c, 'Not everyone has signed yet');
      const object = await c.env.PRIVATE_STORAGE.get(envelope.finalStorageKey);
      if (!object) return error.notFound(c, 'Signed document', envelope.id);
      const filename = `${envelope.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'signed'}.pdf`;
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${filename.replaceAll('"', '')}"`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (err) {
      return respond(c, err);
    }
  });

  app.route('/', signer);
  return app;
}

export default createSignPortalRoutes();
