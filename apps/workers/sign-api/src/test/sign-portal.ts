/**
 * The signer portal in tests, as apps/web/sign-portal runs it: each path of
 * its routes maps to one operation of @weldsuite/sign-domain/portal, with
 * the signer's IP and browser it reads from the request.
 *
 * In conformance mode (CONFORMANCE_TARGET=rust) each call also goes to the
 * Rust backend's `/public/sign-portal` endpoints (ADR FE-017) the way
 * `portal-client.ts` sends it on Kubernetes (the portal key, `X-Signer-Ip`,
 * `User-Agent`, the session as a bearer token), and the two answers are
 * compared like any route's (worker-kit's conformance.ts): status, the
 * headers the portal passes on, body, and side effects, including those of
 * finalizing, which the last signature starts. The test gets Rust's answer.
 *
 * What each run starts from: a write runs on Rust first, against the
 * test's databases, bucket and KV namespace; TypeScript then runs on copies
 * taken before (the harness's database clones, and here a copy of the KV
 * namespace and a bucket whose writes stay in an overlay), so the test's
 * own assertions see Rust's writes only. Rust reaches the KV namespace and,
 * when the test has one, its `FINALIZE_ENVELOPE` stub through the harness's
 * bridges; TypeScript then gets a twin stub of its own.
 */

import { conformanceTarget, conformanceRequest, createSideEffectRecorder, kvBucketUrl, workflowBridgeUrl, type SideEffects } from '@weldsuite/worker-kit/testing/conformance';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import type { Database } from '@weldsuite/worker-kit/db';
import type { PortalContext, SignerMeta, SignPortal } from '@weldsuite/sign-domain/portal';

/** Where the Rust backend serves the signer operations (`SIGN_PORTAL_PATH`). */
const BASE = '/public/sign-portal';

/** The headers of an answer that reach the signer (`PASSED_HEADERS` in portal-client.ts). */
const PASSED_HEADERS = ['content-type', 'content-disposition', 'cache-control', 'x-content-type-options'] as const;

export interface PortalCallerOptions {
  /** The portal's bindings (`PRIVATE_STORAGE`, `WORKSPACE_CACHE`, `SIGN_*`, `FINALIZE_ENVELOPE`, …). */
  env: Record<string, unknown>;
  meta: SignerMeta;
  /** The portal's operations, opening every link on `tenantDb`. */
  portal: (tenantDb: Database) => SignPortal;
  /** The test's databases: the tenant every link opens, and the master (shared with Rust). */
  tenantDb: Database;
  masterDb: unknown;
  /** `workspaces.id` and Clerk org id of the test's workspace. */
  workspaceId: string;
  orgId: string;
  /**
   * Conformance mode: the Workflow binding TypeScript starts finalizing on,
   * while Rust starts it on `env.FINALIZE_ENVELOPE`. A stub keeps state, so
   * each backend needs its own.
   */
  typescriptWorkflow?: unknown;
}

type Op = (ops: SignPortal, ctx: PortalContext, session: string | undefined, input: unknown) => Promise<Response>;

/** The portal's paths: the operation, and the route pattern the conformance report names. */
function operation(path: string): { op: Op; route: string } {
  const document = /^\/documents\/([^/]+)$/.exec(path);
  if (document) {
    const id = decodeURIComponent(document[1]!);
    return { op: (ops, ctx, session) => ops.document(ctx, session, id), route: `${BASE}/documents/:documentId` };
  }
  const ops: Record<string, Op> = {
    '/session': (o, ctx, _s, input) => o.openSession(ctx, input),
    '/verify': (o, ctx, _s, input) => o.verify(ctx, input),
    '/resend-code': (o, ctx, _s, input) => o.resendCode(ctx, input),
    '/envelope': (o, ctx, session) => o.envelope(ctx, session),
    '/consent': (o, ctx, session, input) => o.consent(ctx, session, input),
    '/complete': (o, ctx, session, input) => o.complete(ctx, session, input),
    '/decline': (o, ctx, session, input) => o.decline(ctx, session, input),
    '/download': (o, ctx, session) => o.download(ctx, session),
  };
  const op = ops[path];
  if (!op) throw new Error(`no portal operation for ${path}`);
  return { op, route: `${BASE}${path}` };
}

/** A bucket whose writes stay in an overlay: reads fall through to `bucket` for anything not written here. */
function overlayBucket(bucket: R2Bucket): R2Bucket {
  const written = new Map<string, Uint8Array | null>();
  return {
    async put(key: string, value: Uint8Array) {
      written.set(key, new Uint8Array(value));
      return {};
    },
    async get(key: string) {
      if (!written.has(key)) return bucket.get(key);
      const bytes = written.get(key);
      if (!bytes) return null;
      return { body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) written.set(key, null);
    },
  } as unknown as R2Bucket;
}

/** A copy of a memory KV namespace (`createMemoryKv()`). */
function copyKv(kv: unknown): KVNamespace {
  const copy = createMemoryKv();
  for (const [key, value] of (kv as { store: Map<string, string> }).store) copy.store.set(key, value);
  return copy;
}

/**
 * The signed PDF's bytes differ between pdf-lib and lopdf by construction
 * (see `finalSha256` in conformance.ts), so its size does too where it
 * reaches a side effect: the "everyone signed" mail's attachment and the
 * filed copies' `file:created` events.
 */
export function maskSignedPdfSizes(effects: SideEffects): SideEffects {
  const masked = (data: unknown) =>
    data && typeof data === 'object' && (data as { mimeType?: unknown }).mimeType === 'application/pdf'
      ? { ...(data as Record<string, unknown>), fileSize: '<pdf-size>' }
      : data;
  return {
    ...effects,
    events: effects.events.map((event) =>
      event && typeof event === 'object' && (event as { entityType?: unknown }).entityType === 'file'
        ? { ...(event as Record<string, unknown>), data: masked((event as { data?: unknown }).data) }
        : event,
    ),
    mail: effects.mail.map((mail) => ({
      ...mail,
      attachments: mail.attachments.map((a) => (a.contentType === 'application/pdf' ? { ...a, size: -1 } : a)),
    })),
  };
}

export function portalCaller(options: PortalCallerOptions) {
  const { env, meta } = options;
  const pending: Promise<unknown>[] = [];
  const target = conformanceTarget();
  const sideEffects = target ? createSideEffectRecorder() : null;

  const run = (op: Op, tenantDb: Database, runEnv: Record<string, unknown>, session: string | undefined, input: unknown, track: (p: Promise<unknown>) => void) => {
    const ctx: PortalContext = { env: runEnv as unknown as PortalContext['env'], meta, waitUntil: track };
    return op(options.portal(tenantDb), ctx, session, input);
  };

  async function request(path: string, init: RequestInit = {}, session?: string): Promise<Response> {
    const { op, route } = operation(path);
    const input: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    if (!target || !sideEffects) {
      return run(op, options.tenantDb, env, session, input, (p) => pending.push(p.catch(() => undefined)));
    }

    const method = (init.method ?? 'GET').toUpperCase();
    const isWrite = method !== 'GET';
    // TypeScript's run of a write starts from the KV namespace as it was before Rust's.
    const kv = isWrite ? copyKv(env.WORKSPACE_CACHE) : (env.WORKSPACE_CACHE as KVNamespace);
    const headers = new Headers({ accept: 'application/json', 'x-sign-portal-key': String(env.SIGN_PORTAL_SECRET ?? '') });
    if (meta.ip) headers.set('x-signer-ip', meta.ip);
    if (meta.userAgent) headers.set('user-agent', meta.userAgent);
    if (session) headers.set('authorization', `Bearer ${session}`);
    if (isWrite) headers.set('content-type', 'application/json');
    return conformanceRequest({
      target,
      ctx: {
        userId: 'system',
        orgId: options.orgId,
        workspaceId: options.workspaceId,
        clerkOrgId: options.orgId,
        sessionId: '',
        tenantDb: options.tenantDb,
        masterDb: options.masterDb as Database,
      },
      env,
      input: `${BASE}${path}`,
      init: { method, headers, body: isWrite ? JSON.stringify(input ?? null) : undefined },
      context: {
        cache: await kvBucketUrl(env.WORKSPACE_CACHE as never),
        jobs: env.FINALIZE_ENVELOPE ? await workflowBridgeUrl(env.FINALIZE_ENVELOPE as never) : undefined,
      },
      compareHeaders: PASSED_HEADERS,
      normalizeEffects: maskSignedPdfSizes,
      sideEffects,
      runTypeScript: async (tenantDb) => {
        const runEnv = {
          ...env,
          ...sideEffects.bindings,
          WORKSPACE_CACHE: kv,
          PRIVATE_STORAGE: isWrite ? overlayBucket(env.PRIVATE_STORAGE as R2Bucket) : env.PRIVATE_STORAGE,
          FINALIZE_ENVELOPE: env.FINALIZE_ENVELOPE ? options.typescriptWorkflow : undefined,
        };
        let res: Response;
        try {
          res = await run(op, tenantDb, runEnv, session, input, (p) => sideEffects.track(p.catch(() => undefined)));
        } catch (err) {
          // What the portal's server route answers for an operation that throws.
          console.error('[sign-portal test] operation threw:', err);
          res = Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } }, { status: 500 });
        }
        const out = new Headers(res.headers);
        out.set('x-weld-route', route);
        return new Response(res.body, { status: res.status, headers: out });
      },
    });
  }

  return { pending, request };
}
