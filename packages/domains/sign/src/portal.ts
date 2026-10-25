/**
 * The signer portal's operations (ADR SIGN-002, as amended by FE-016): what a
 * person outside the workspace does with a signing link. apps/web/sign-portal
 * runs them in its own Worker, against the tenant DB, with no API in between.
 *
 *   openSession  { token }        → ready (session) | code_required | closed; 404 unknown link
 *   verify       { token, code }  → ready; 400 INVALID_CODE, 429 LOCKED
 *   resendCode   { token }        → a new emailed code; 429 when asked too often
 *   envelope                      → what this signer sees
 *   document     documentId       → the PDF with earlier signers' values drawn in
 *   consent      { disclosureVersion }
 *   complete     { values, signature, initials, timeZone }
 *                                 → 503 when the last signature could not start finalizing; again retries
 *   decline      { reason }
 *   download                      → the signed PDF (completed requests)
 *
 * Each returns a `Response` in the platform's shape (`{ data }`, or
 * `{ error: { code, message, details? } }` with its status), so the portal's
 * routes pass it on as is. The last six take the signer session token that
 * openSession / verify issued.
 *
 * Writes publish `sign_envelope` events (`signed`, `declined`); the evidence
 * of each step is `sign_events`, with the signer's IP and browser (`meta`).
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import { getMasterDb, getWorkspaceContextForOrg, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import {
  portalCompleteSchema,
  portalConsentSchema,
  portalDeclineSchema,
  portalSessionSchema,
  portalVerifySchema,
  type SignPortalSessionResponse,
} from '@weldsuite/app-api-client/schemas/weldsign';
import type { z } from 'zod';
import type { FinalizeEnvelopeParams, SignEnv } from './env';
import { SignError } from './errors';
import { resolveLink, resolveLinkByHash, revokeEnvelopeLinks, type ResolvedLink } from './links';
import { signSession, verifySession, type SignerSession } from './session';
import { checkCode, emailCodeHash, emailHint, isLocked, issueEmailCode, newEmailCode, CODE_TTL_SECONDS } from './codes';
import { codeAttemptsFor } from './code-attempts';
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
} from './signing';
import { advanceAfterSigning, awaitingFinalize } from './sending';
import { loadSignBrand } from './settings';
import { sendCode, sendDeclined, workspaceBrand } from './mail';
import { codeHash } from './hash';
import { finalizeEnvelope } from './finalize-envelope';

export type { SignerMeta } from './signing';

/** What every operation runs with: the Worker's bindings, who is asking, and its `waitUntil`. */
export interface PortalContext {
  env: SignEnv;
  /** The signer's IP and browser, for the evidence trail. */
  meta: SignerMeta;
  /** Keeps background work (events, mail) running after the response. */
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface PortalWorkspace {
  /** Master `workspaces.id`. */
  id: string;
  db: Database;
  suspended: boolean;
}

/** Seams for tests: the master DB, the tenant DB of an org, and finalizing without the Workflow. */
export interface PortalDeps {
  master: (env: SignEnv) => MasterDatabase;
  workspace: (env: SignEnv, clerkOrgId: string) => Promise<PortalWorkspace>;
  finalize: (env: SignEnv, params: FinalizeEnvelopeParams) => Promise<void>;
}

const defaultDeps: PortalDeps = {
  master: (env) => getMasterDb(env),
  workspace: (env, orgId) => getWorkspaceContextForOrg(env, orgId),
  finalize: finalizeEnvelope,
};

// ── Responses ──────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => Response.json(body, { status });
const ok = (data: unknown) => json({ data });
const fail = (status: number, code: string, message: string, details?: unknown) =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

const notFound = (resource: string, id?: string) =>
  fail(404, 'NOT_FOUND', id ? `${resource} with ID '${id}' not found` : `${resource} not found`);
const conflict = (message: string) => fail(409, 'CONFLICT', message);
const unavailable = (message: string) => fail(503, 'SERVICE_UNAVAILABLE', message);
const locked = () => fail(429, 'LOCKED', 'Too many wrong codes. Try again later.');

function respond(err: unknown): Response {
  if (!(err instanceof SignError)) throw err;
  if (err.kind === 'not_found') return notFound(err.resource ?? 'Resource');
  if (err.kind === 'conflict') return conflict(err.message);
  return fail(400, 'BAD_REQUEST', err.message);
}

/** Validates a request body; a failure is the 400 a route answers with. */
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): { data: z.infer<S> } | { error: Response } {
  const result = schema.safeParse(input);
  return result.success
    ? { data: result.data }
    : { error: fail(400, 'BAD_REQUEST', 'Invalid request', result.error.flatten()) };
}

/** Codes are compared in their keyed, recipient-bound form (`codeHash` in ./hash). */
function hasherFor(env: SignEnv, recipientId: string) {
  return (code: string) => codeHash(env.SIGN_SESSION_SECRET!, recipientId, code);
}

const PDF_HEADERS = { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export type SignPortal = ReturnType<typeof createSignPortal>;

export function createSignPortal(overrides: Partial<PortalDeps> = {}) {
  const deps: PortalDeps = { ...defaultDeps, ...overrides };

  type Opened = { link: ResolvedLink; workspace: PortalWorkspace; ref: SignerRef };
  type Signer = { session: SignerSession; workspace: PortalWorkspace };

  /** The workspace and signer a link points at; null for anything a signer must not learn more about. */
  async function open(env: SignEnv, token: string): Promise<Opened | null> {
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
  async function startFinalizing(ctx: PortalContext, params: FinalizeEnvelopeParams): Promise<void> {
    const workflow = ctx.env.FINALIZE_ENVELOPE;
    if (!workflow) {
      ctx.waitUntil(deps.finalize(ctx.env, params));
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

  async function ready(ctx: PortalContext, opened: Opened): Promise<Response> {
    await markOpened(opened.workspace.db, opened.ref, ctx.meta);
    // Everyone signed but finalizing never got going: reopening any link of the request starts it again.
    if (await awaitingFinalize(opened.workspace.db, opened.ref.envelope)) {
      const params: FinalizeEnvelopeParams = { clerkOrgId: opened.link.clerkOrgId, workspaceId: opened.workspace.id, envelopeId: opened.link.envelopeId };
      ctx.waitUntil(
        startFinalizing(ctx, params).catch((err: unknown) => console.error(`[sign-portal] could not start finalizing ${params.envelopeId}:`, err)),
      );
    }
    const { token, expiresAt } = await signSession(ctx.env.SIGN_SESSION_SECRET!, {
      orgId: opened.link.clerkOrgId,
      envelopeId: opened.link.envelopeId,
      recipientId: opened.link.recipientId,
      tokenHash: opened.link.tokenHash,
    });
    return ok({ state: 'ready', session: token, expiresAt: expiresAt.toISOString() } satisfies SignPortalSessionResponse);
  }

  /** Runs `run` for a valid signer session; 503 without the secret, 401 for a bad or expired session. */
  async function withSigner(ctx: PortalContext, sessionToken: string | undefined, run: (signer: Signer) => Promise<Response>): Promise<Response> {
    if (!ctx.env.SIGN_SESSION_SECRET) return unavailable('Signing is not configured');
    const session = sessionToken ? await verifySession(ctx.env.SIGN_SESSION_SECRET, sessionToken) : null;
    if (!session) return fail(401, 'UNAUTHORIZED', 'Your session has expired. Open the link again.');
    // A session lasts only as long as its link: a corrected email, void or decline revokes the link.
    const link = await resolveLinkByHash(deps.master(ctx.env), session.tokenHash);
    if (!link || link.envelopeId !== session.envelopeId || link.recipientId !== session.recipientId || link.clerkOrgId !== session.orgId) {
      return fail(401, 'UNAUTHORIZED', 'Your session has expired. Open the link again.');
    }
    let workspace: PortalWorkspace;
    try {
      workspace = await deps.workspace(ctx.env, session.orgId);
    } catch {
      return notFound('Envelope');
    }
    if (workspace.suspended) return notFound('Envelope');
    try {
      return await run({ session, workspace });
    } catch (err) {
      return respond(err);
    }
  }

  const current = ({ session, workspace }: Signer) => loadSigner(workspace.db, session.envelopeId, session.recipientId);

  async function view(ctx: PortalContext, signer: Signer, ref: SignerRef) {
    const db = signer.workspace.db;
    const brand = await loadSignBrand(db);
    const name = brand.name ?? (await workspaceBrand({ env: ctx.env, db, clerkOrgId: signer.session.orgId, master: deps.master(ctx.env) })).name;
    return portalView(db, ref, { name, color: brand.color, logoUrl: brand.logoUrl });
  }

  /**
   * After the last signature: start finalizing. When it cannot start, the
   * signer hears so (503) while their signature stays saved, and finishing
   * again retries the start.
   */
  async function finish(ctx: PortalContext, signer: Signer, params: FinalizeEnvelopeParams): Promise<Response> {
    try {
      await startFinalizing(ctx, params);
    } catch (err) {
      console.error(`[sign-portal] could not start finalizing ${params.envelopeId}:`, err);
      return unavailable('Your signature is saved, but the request could not be completed yet. Try again in a moment.');
    }
    return ok(await view(ctx, signer, await current(signer)));
  }

  return {
    async openSession(ctx: PortalContext, input: unknown): Promise<Response> {
      if (!ctx.env.SIGN_SESSION_SECRET) return unavailable('Signing is not configured');
      const body = parse(portalSessionSchema, input);
      if ('error' in body) return body.error;
      const opened = await open(ctx.env, body.data.token);
      if (!opened) return notFound('Signing link');
      const reason = closedReason(opened.ref.envelope);
      if (reason) return ok({ state: 'closed', reason } satisfies SignPortalSessionResponse);
      const { recipient } = opened.ref;
      if (recipient.authMode === 'link' || recipient.role === 'cc') return ready(ctx, opened);

      const kv = ctx.env.WORKSPACE_CACHE;
      if (await isLocked(codeAttemptsFor(ctx.env.SIGN_CODE_ATTEMPTS, opened.link.tokenHash))) return locked();
      if (recipient.authMode === 'email_code') {
        const code = newEmailCode();
        if (await issueEmailCode(kv, opened.link.tokenHash, code, hasherFor(ctx.env, recipient.id))) {
          await sendCode(
            { env: ctx.env, db: opened.workspace.db, clerkOrgId: opened.link.clerkOrgId, envelope: opened.ref.envelope, master: deps.master(ctx.env) },
            recipient,
            code,
            CODE_TTL_SECONDS / 60,
          );
        }
      }
      return ok({
        state: 'code_required',
        method: recipient.authMode === 'email_code' ? 'email_code' : 'access_code',
        emailHint: recipient.authMode === 'email_code' ? emailHint(recipient.email) : null,
      } satisfies SignPortalSessionResponse);
    },

    async verify(ctx: PortalContext, input: unknown): Promise<Response> {
      if (!ctx.env.SIGN_SESSION_SECRET) return unavailable('Signing is not configured');
      const body = parse(portalVerifySchema, input);
      if ('error' in body) return body.error;
      const { token, code } = body.data;
      const opened = await open(ctx.env, token);
      if (!opened) return notFound('Signing link');
      const reason = closedReason(opened.ref.envelope);
      if (reason) return ok({ state: 'closed', reason } satisfies SignPortalSessionResponse);
      const { recipient } = opened.ref;
      if (recipient.authMode === 'link') return ready(ctx, opened);
      const kv = ctx.env.WORKSPACE_CACHE;
      const expected = recipient.authMode === 'email_code' ? await emailCodeHash(kv, opened.link.tokenHash) : recipient.accessCodeHash;
      const result = await checkCode(
        kv,
        codeAttemptsFor(ctx.env.SIGN_CODE_ATTEMPTS, opened.link.tokenHash),
        opened.link.tokenHash,
        expected,
        code,
        hasherFor(ctx.env, recipient.id),
      );
      await recordCodeCheck(opened.workspace.db, opened.ref, result.ok, ctx.meta);
      if (!result.ok) {
        return result.locked ? locked() : fail(400, 'INVALID_CODE', 'That code is not correct', { attemptsLeft: result.attemptsLeft });
      }
      return ready(ctx, opened);
    },

    async resendCode(ctx: PortalContext, input: unknown): Promise<Response> {
      if (!ctx.env.SIGN_SESSION_SECRET) return unavailable('Signing is not configured');
      const body = parse(portalSessionSchema, input);
      if ('error' in body) return body.error;
      const opened = await open(ctx.env, body.data.token);
      if (!opened) return notFound('Signing link');
      const { recipient, envelope } = opened.ref;
      if (recipient.authMode !== 'email_code' || closedReason(envelope)) return conflict('No code to send');
      const kv = ctx.env.WORKSPACE_CACHE;
      if (await isLocked(codeAttemptsFor(ctx.env.SIGN_CODE_ATTEMPTS, opened.link.tokenHash))) return locked();
      const code = newEmailCode();
      if (!(await issueEmailCode(kv, opened.link.tokenHash, code, hasherFor(ctx.env, recipient.id)))) {
        return fail(429, 'TOO_SOON', 'A code was sent a moment ago');
      }
      await sendCode(
        { env: ctx.env, db: opened.workspace.db, clerkOrgId: opened.link.clerkOrgId, envelope, master: deps.master(ctx.env) },
        recipient,
        code,
        CODE_TTL_SECONDS / 60,
      );
      return ok({ sent: true });
    },

    envelope(ctx: PortalContext, session: string | undefined): Promise<Response> {
      return withSigner(ctx, session, async (signer) => ok(await view(ctx, signer, await current(signer))));
    },

    document(ctx: PortalContext, session: string | undefined, documentId: string): Promise<Response> {
      return withSigner(ctx, session, async (signer) => {
        const ref = await current(signer);
        if (portalMode(ref.envelope, ref.recipient) === 'closed') return conflict('This request is closed');
        const object = await signerDocument(signer.workspace.db, ctx.env.PRIVATE_STORAGE, ref.envelope.id, documentId);
        return new Response(object.body, { headers: PDF_HEADERS });
      });
    },

    consent(ctx: PortalContext, session: string | undefined, input: unknown): Promise<Response> {
      return withSigner(ctx, session, async (signer) => {
        const body = parse(portalConsentSchema, input);
        if ('error' in body) return body.error;
        await recordConsent(signer.workspace.db, await current(signer), body.data.disclosureVersion, ctx.meta);
        return ok({ consented: true });
      });
    },

    complete(ctx: PortalContext, session: string | undefined, input: unknown): Promise<Response> {
      return withSigner(ctx, session, async (signer) => {
        const body = parse(portalCompleteSchema, input);
        if ('error' in body) return body.error;
        const { db, id: workspaceId } = signer.workspace;
        const orgId = signer.session.orgId;
        const ref = await current(signer);
        const params: FinalizeEnvelopeParams = { clerkOrgId: orgId, workspaceId, envelopeId: ref.envelope.id };
        // A retry after finalizing could not start: the signature is already saved.
        if (ref.recipient.status === 'signed' && (await awaitingFinalize(db, ref.envelope))) return finish(ctx, signer, params);
        await completeSigning({ db, bucket: ctx.env.PRIVATE_STORAGE, workspaceId: orgId, meta: ctx.meta }, ref, body.data);
        ctx.waitUntil(
          publishEntityEventRaw({
            env: ctx.env,
            workspaceId: orgId,
            userId: 'system',
            source: 'api',
            entityType: 'sign_envelope',
            action: 'signed',
            entityId: ref.envelope.id,
            data: { id: ref.envelope.id, title: ref.envelope.title, status: ref.envelope.status },
          }),
        );
        const next = await advanceAfterSigning(
          { env: ctx.env, db, master: deps.master(ctx.env), clerkOrgId: orgId, workspaceId },
          ref.envelope,
        );
        if (next === 'all_signed') return finish(ctx, signer, params);
        return ok(await view(ctx, signer, await current(signer)));
      });
    },

    decline(ctx: PortalContext, session: string | undefined, input: unknown): Promise<Response> {
      return withSigner(ctx, session, async (signer) => {
        const body = parse(portalDeclineSchema, input);
        if ('error' in body) return body.error;
        const { db, id: workspaceId } = signer.workspace;
        const orgId = signer.session.orgId;
        const ref = await current(signer);
        const { reason } = body.data;
        await declineSigning(db, ref, reason, ctx.meta);
        await revokeEnvelopeLinks(deps.master(ctx.env), workspaceId, ref.envelope.id);
        ctx.waitUntil(
          Promise.all([
            sendDeclined(
              { env: ctx.env, db, clerkOrgId: orgId, envelope: ref.envelope, master: deps.master(ctx.env) },
              ref.recipient.name || ref.recipient.email || '',
              reason,
              null,
            ),
            publishEntityEventRaw({
              env: ctx.env,
              workspaceId: orgId,
              userId: 'system',
              source: 'api',
              entityType: 'sign_envelope',
              action: 'declined',
              entityId: ref.envelope.id,
              data: { id: ref.envelope.id, title: ref.envelope.title, status: 'declined' },
            }),
          ]),
        );
        return ok(await view(ctx, signer, await current(signer)));
      });
    },

    download(ctx: PortalContext, session: string | undefined): Promise<Response> {
      return withSigner(ctx, session, async (signer) => {
        const { envelope } = await current(signer);
        if (envelope.status !== 'completed' || !envelope.finalStorageKey) return conflict('Not everyone has signed yet');
        const object = await ctx.env.PRIVATE_STORAGE.get(envelope.finalStorageKey);
        if (!object) return notFound('Signed document', envelope.id);
        const filename = `${envelope.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'signed'}.pdf`;
        return new Response(object.body, {
          headers: { ...PDF_HEADERS, 'Content-Disposition': `attachment; filename="${filename.replaceAll('"', '')}"` },
        });
      });
    },
  };
}
