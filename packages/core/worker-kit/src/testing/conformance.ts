/**
 * Conformance mode (phase P2 of the editions plan): the worker tests drive the
 * Rust backend (`rust/`) over HTTP, unchanged, and every answer is compared
 * with the Hono app's.
 *
 *   CONFORMANCE_TARGET=rust            send `request()` to the Rust server
 *   CONFORMANCE_TARGET=record          run as usual, only record routes and statuses
 *                                      (the per-worker coverage report)
 *   CONFORMANCE_RUST_URL=http://…      where it listens (default 127.0.0.1:18089)
 *   CONFORMANCE_STRICT=0               record differences instead of failing
 *   CONFORMANCE_REPORT_DIR=…           append one JSON line per request there
 *
 * Per request, from `createTestApp().request()`:
 *
 * 1. The test's pglite database is served over the Postgres wire protocol
 *    (`@electric-sql/pglite-socket`), so Rust queries the same seeded state.
 *    Its R2 bucket bindings (`PRIVATE_STORAGE`, `STORAGE`) are served over
 *    HTTP (./bucket-bridge.ts), so Rust reads and writes the same objects,
 *    and so is its KV namespace (`WORKSPACE_CACHE`, ./kv-bridge.ts).
 * 2. The request goes to Rust with the test's context (user, org, workspace,
 *    pre-resolved permissions, database URL) in `X-Weld-Conformance`. Only a
 *    server built with the `conformance` Cargo feature reads it. An absolute
 *    URL keeps its origin: Rust gets it as `X-Forwarded-Host`/`-Proto`, the
 *    Hono app the URL itself.
 * 3. The same request runs on the Hono app: for a read on the same database
 *    first; for a write first too, but on a clone of the database and with
 *    copy-on-write views of the buckets and KV (./write-isolation.ts), so
 *    both start from the same state and only Rust's writes reach the test's
 *    database and stubs, which its own assertions then check.
 * 4. Status and JSON are compared (ids, timestamps and cursors normalised for
 *    writes), the body is validated against the route's Zod schema when one is
 *    registered (./conformance-schemas.ts), and the outcome is recorded.
 * 5. Side effects are compared too: the Hono app gets recording
 *    `ENTITY_EVENTS` and `REALTIME` bindings (unless the test brings its own),
 *    Rust records through its port doubles, and both lists must match. The
 *    runner runs one test file at a time, so Rust's recordings are this
 *    request's. Customer mail (the test's `SEND_EMAIL`, ./send-email-bridge.ts)
 *    and the outbound guard's ledgers (`OUTBOUND_LEDGER`, ./ledger-bridge.ts)
 *    are shared with Rust over HTTP and compared per envelope and per call.
 *
 * The test gets Rust's response, so its assertions check Rust too.
 */

import { createServer } from 'node:net';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../env';
import { pgliteClientOf } from './pglite';
import { wireCompatiblePglite } from './pglite-wire';
import { schemaFor } from './conformance-schemas';
import { bucketUrls } from './bucket-bridge';
import { kvUrls } from './kv-bridge';
import { realtimeUrl } from './realtime-bridge';
import { isolatedEnv } from './write-isolation';
import { maskVolatile, maskVolatileEvents } from './conformance-volatile';
import { sameBody } from './conformance-binary';
import { createMailCollector, mailRecord, type MailRecord, type RustMail, type SentByTypeScript } from './conformance-mail';
import { recordTypeScriptSends, sendEmailUrl, sortSends, takeRustSends } from './send-email-bridge';
import {
  type WorkflowCall,
  recordTypeScriptWorkflowCalls,
  takeRustWorkflowCalls,
  workflowUrls,
} from './workflow-bridge';
import {
  type LedgerCall,
  ledgerUrls,
  recordTypeScriptLedgerCalls,
  sortLedgerCalls,
  takeRustLedgerCalls,
} from './ledger-bridge';
import type { SendRecord } from './mime-record';
import {
  type ServiceCall,
  recordTypeScriptServiceCalls,
  serviceBindingUrls,
  sortServiceCalls,
  takeRustServiceCalls,
} from './service-binding-bridge';
import {
  type OutboundCall,
  outboundBridgeUrl,
  recordOutbound,
  sortOutbound,
  takeRustOutbound,
} from './outbound-bridge';

// The signer portal's doubles for Rust (ConformanceRequest.context).
export { kvBucketUrl } from './bucket-bridge';
export { workflowBridgeUrl } from './workflow-start-bridge';

export interface ConformanceTarget {
  url: string;
  strict: boolean;
  reportDir: string | undefined;
}

/** The Rust server to send requests to, or null outside conformance mode. */
export function conformanceTarget(): ConformanceTarget | null {
  if (process.env.CONFORMANCE_TARGET !== 'rust') return null;
  return {
    url: (process.env.CONFORMANCE_RUST_URL ?? 'http://127.0.0.1:18089').replace(/\/$/, ''),
    strict: process.env.CONFORMANCE_STRICT !== '0',
    reportDir: process.env.CONFORMANCE_REPORT_DIR || undefined,
  };
}

/**
 * Record-only mode: the tests run on the Hono app as usual and the routes they
 * reach are recorded, for the coverage report of a worker that isn't ported
 * yet (playbook step 1). Needs CONFORMANCE_REPORT_DIR.
 */
export function recordOnlyTarget(): ConformanceTarget | null {
  if (process.env.CONFORMANCE_TARGET !== 'record' || !process.env.CONFORMANCE_REPORT_DIR) return null;
  return { url: '', strict: false, reportDir: process.env.CONFORMANCE_REPORT_DIR };
}

/** Request header carrying the test's context to the Rust server. */
export const CONFORMANCE_HEADER = 'X-Weld-Conformance';

/** Response header naming the route that answered (both runtimes set it in this mode). */
export const ROUTE_HEADER = 'X-Weld-Route';

/**
 * Request header a test sets on a GET that writes (a record created on first
 * access), so it is compared as a write: Rust on the database, TypeScript on a
 * copy. Run as a read, TypeScript would create the record and Rust then find
 * it. Neither backend reads it.
 */
export const CONFORMANCE_WRITE_HEADER = 'X-Weld-Conformance-Write';

/**
 * Env bindings the Rust server honours per request in conformance mode.
 * `CLERK_JWT_KEY` (and `CLERK_AUTHORIZED_PARTIES`) let a test sign its own
 * session tokens for the routes that verify one themselves.
 */
export const FORWARDED_ENV = [
  'PERMISSIONS_APP_ENFORCE',
  'SIGN_SESSION_SECRET',
  'SIGN_PORTAL_URL',
  'SIGN_PORTAL_SECRET',
  'R2_PUBLIC_URL',
  'ENVIRONMENT',
  'PUBLIC_APP_URL',
  'STORAGE_SIGNING_KEY',
  'CLERK_JWT_KEY',
  'CLERK_AUTHORIZED_PARTIES',
  // WeldApps: bundle link signing, the bundle origin, the publisher allowlist
  // and where the app gateway forwards to.
  'INTERNAL_API_SECRET',
  'USER_APP_BUNDLE_SIGNING_KEY',
  'USER_APP_BUNDLE_ORIGIN',
  'USER_APP_FRAME_ANCESTORS',
  'WELDSUITE_APP_PUBLISHER_WORKSPACE_IDS',
  'EXTERNAL_API_URL',
  // WeldCalendar: the Google Calendar app credentials (a token refresh before a push).
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  // WeldPass: the root keys that wrap every vault's key.
  'WELDPASS_ROOT_KEY',
  'WELDPASS_ROOT_KEY_V2',
  // WeldBooks: the field encryption keys of sealed SSNs, TINs and bank numbers.
  'DATABASE_ENCRYPTION_KEY',
  'DATABASE_ENCRYPTION_KEY_V2',
  // WeldBooks: the platform page a W-9 request link points at.
  'PLATFORM_URL',
  // WeldBooks payment runs: a test that makes the payments service fail after
  // n payments (a vi.mock on the TypeScript side) hands Rust the same n.
  'CONFORMANCE_FAIL_RECORD_PAYMENT_AFTER',
  // WeldMail: the outbound guard's staff API secret, and whether the worker
  // has a master database URL (the guard checks sender ownership only then).
  'OUTBOUND_ADMIN_SECRET',
  'DATABASE_URL_MASTER',
  // WeldDesk: the Discord bot (agent replies, ticket threads closed), and the
  // Discord and Slack OAuth apps (connect, token exchange and refresh).
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  // WeldDesk's public webchat API (helpdesk-widget-api): the secret its realtime
  // tokens are signed with, the realtime origin it advertises to the widget, and
  // the secret its realtime publishes carry.
  'WIDGET_TOKEN_SECRET',
  'REALTIME_PUBLIC_URL',
  'REALTIME_INTERNAL_SECRET',
  // WeldHR: WeldSuite's ODB number in a loonaangifte, and the platform origin
  // payroll mail links to (the keyring below also seals an employee's
  // sensitive block and payroll bank details).
  'NL_SOFTWARE_RELATION_NUMBER',
  'APP_URL',
  // The workspace keyring: WeldStash opens the stored Sendcloud secret with it
  // (the pick-list ship action), WeldAds seals its connections' OAuth tokens
  // with it (`encryptField`), WeldCommerce opens stored credentials with it
  // (Sendcloud, the sales tax engines, store connections).
  'DATABASE_ENCRYPTION_KEY',
  'DATABASE_ENCRYPTION_KEY_V2',
  // WeldCommerce: the B2B portal's origin.
  'COMMERCE_PORTAL_URL',
  // WeldAds: the Meta app (OAuth and the Graph API).
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  // WeldSocial: PostPeer (the API key, base URL and BYOK app ids) and the
  // secret its delivery webhooks are signed with.
  'POSTPEER_API_KEY',
  'POSTPEER_BASE_URL',
  'POSTPEER_APP_IDS',
  'POSTPEER_WEBHOOK_SECRET',
  // WeldData: the Lemlist lead database, and the email finders an enrichment
  // run calls.
  'LEMLIST_API_KEY',
  'FINDYMAIL_API_KEY',
  'PROSPEO_API_KEY',
  // WeldBooks bank feeds: the providers on offer per country, their webhook
  // base, and each aggregator's credentials (Plaid, Stripe Financial
  // Connections, Ponto, Enable Banking).
  'BANK_FEED_PROVIDERS',
  'BANK_FEED_WEBHOOK_URL',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'PLAID_REDIRECT_URI',
  'PLAID_COUNTRY_CODES',
  'STRIPE_FC_SECRET_KEY',
  'STRIPE_FC_API_VERSION',
  'PONTO_CLIENT_ID',
  'PONTO_CLIENT_SECRET',
  'ENABLE_BANKING_APP_ID',
  'ENABLE_BANKING_PRIVATE_KEY',
  // WeldReach: Mailpool (the API key and base URL, the webhook secret), the
  // warmup network's key and the domain forwarded replies arrive on.
  'MAILPOOL_API_KEY',
  'MAILPOOL_API_URL',
  'MAILPOOL_WEBHOOK_SECRET',
  'WELDREACH_WARMUP_KEY',
  'REACH_INBOUND_DOMAIN',
] as const;

/**
 * The test's own clock, when it fakes `Date` (`vi.useFakeTimers({ toFake:
 * ['Date'] })` + `vi.setSystemTime(...)`): the route's "today" is the test's,
 * so Rust gets it too (`CONFORMANCE_NOW`, read only by conformance builds of
 * the routes that default a date to today). `performance` keeps the real
 * clock, so a minute's difference means `Date` is faked.
 */
function fakedNow(): Record<string, string> {
  const now = Date.now();
  const real = performance.timeOrigin + performance.now();
  return Math.abs(now - real) > 60_000 ? { CONFORMANCE_NOW: new Date(now).toISOString() } : {};
}

/** The test's env values the Rust server reads, as strings. */
export function forwardedEnv(env: Record<string, unknown>): Record<string, string> {
  return {
    ...Object.fromEntries(
      FORWARDED_ENV.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name] as string]),
    ),
    ...fakedNow(),
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * GETs that write: they get or create a row (a DM, a record chat) or settle
 * state they find stale, so they run as writes do, TypeScript first on a
 * copy of the database.
 */
const WRITING_READS: RegExp[] = [
  // WeldChat: the 1:1 DM with someone, created on first use.
  /^\/api\/chat-dm\/[^/?]+(\?|$)/,
  // WeldData: the Lemlist filter catalog, cached in KV on a miss.
  /^\/api\/welddata\/filters(\?|$)/,
  // WeldData: a list's cells, its stuck running ones timed out first.
  /^\/api\/welddata\/lists\/[^/?]+\/cells(\?|$)/,
  // WeldBooks: the workspace's accounting settings row, created on first read.
  /^\/api\/accounting-settings(\?|$)/,
  // WeldBooks payment runs: the NACHA file marks its run exported, and it, the
  // MICR print data and the Positive Pay file log the account numbers they reveal.
  /^\/api\/payment-runs\/[^/?]+\/(nacha|checks)(\?|$)/,
  /^\/api\/payment-runs\/positive-pay(\?|$)/,
];

interface ConformanceContext {
  userId: string;
  orgId: string | null;
  workspaceId: string;
  clerkOrgId: string | null;
  sessionId: string;
  factorVerificationAge?: readonly [number, number] | null;
  tenantDb: Database;
  /** The master database, when the routes use one (shared, never cloned). */
  masterDb?: Database;
  /** Other workspaces' tenant databases by reference (shared, never cloned). */
  tenantDbs?: Record<string, Database>;
  permissions?: unknown;
  /** The test's flag evaluator (`context.flags`), if any. */
  flags?: unknown;
  /** `c.get('appAccess')` of an on-request app (`context.appAccess`), if any. */
  appAccess?: unknown;
}

// ── side effects ────────────────────────────────────────────────────────────

export interface SideEffects {
  /** Messages sent to the `ENTITY_EVENTS` queue. */
  events: unknown[];
  /** POSTs to the realtime-worker, as `{ path, body }`. */
  realtime: Array<{ path: string; body: unknown }>;
  /** System mail, compared as records (./conformance-mail.ts). */
  mail: MailRecord[];
  /** Calls to third-party APIs (Clerk, Expo, …), sorted (./outbound-bridge.ts). */
  outbound?: OutboundCall[];
  /** Customer mail handed to `SEND_EMAIL`, per envelope (./send-email-bridge.ts). */
  sendEmail?: SendRecord[];
  /** Calls to the outbound guard's ledgers (./ledger-bridge.ts). */
  ledger?: LedgerCall[];
  /** Calls to Workflow bindings (`EXECUTE_SEQUENCE`, ./workflow-bridge.ts). */
  workflows?: WorkflowCall[];
  /** Calls over service bindings (`BOOKS_INTERNAL`, ./service-binding-bridge.ts). */
  services?: ServiceCall[];
}

/** The URL a `fetch` was called with, whatever form it came in. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Recording `ENTITY_EVENTS` and `REALTIME` bindings for the Hono app, and a
 * `drain()` that waits for the request's `waitUntil` work and returns what
 * it sent.
 */
export function createSideEffectRecorder() {
  const effects: Omit<SideEffects, 'mail'> = { events: [], realtime: [] };
  const mail = createMailCollector();
  let lastMail: SentByTypeScript[] = [];
  const pending: Promise<unknown>[] = [];
  const copy = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
  // Only the `/publish/*` POSTs are side effects; a presence read
  // (`GET /internal/presence`) is a read.
  const recordPublish = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(requestUrl(input));
    if (!url.pathname.startsWith('/publish/')) return;
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    effects.realtime.push({ path: url.pathname, body });
  };
  return {
    bindings: {
      ENTITY_EVENTS: {
        send: async (message: unknown) => {
          effects.events.push(copy(message));
        },
        sendBatch: async (messages: Array<{ body: unknown }>) => {
          for (const message of messages) effects.events.push(copy(message.body));
        },
      },
      REALTIME: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          recordPublish(input, init);
          return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
        },
      },
    },
    /**
     * A test's own `ENTITY_EVENTS` binding (one that keeps what was sent, to
     * assert on), recorded the same way: what the Hono app sends is a side
     * effect Rust's events are compared with, and it still reaches the test's
     * binding.
     */
    wrapEvents(binding: {
      send?(message: unknown): Promise<unknown> | unknown;
      sendBatch?(messages: Array<{ body: unknown }>): Promise<unknown> | unknown;
    }) {
      return {
        send: async (message: unknown) => {
          effects.events.push(copy(message));
          return binding.send?.(message);
        },
        sendBatch: async (messages: Array<{ body: unknown }>) => {
          for (const message of messages) effects.events.push(copy(message.body));
          return binding.sendBatch?.(messages);
        },
      };
    },
    /**
     * A test's own `REALTIME` binding (one that answers presence reads or keeps
     * what was published), recorded the same way: its publishes are side
     * effects too. Reads (presence) go to the test's stub; the publishes the
     * stub keeps are Rust's, handed over after each request (`deliver`), as
     * the test reads Rust's response and mail.
     */
    wrapRealtime(binding: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }) {
      return {
        testOwned: true,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          if (!new URL(requestUrl(input)).pathname.startsWith('/publish/')) return binding.fetch(input, init);
          recordPublish(input, init);
          return Promise.resolve(
            new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
          );
        },
        async deliver(published: Array<{ path: string; body: unknown }>) {
          for (const { path: publishPath, body } of published) {
            await binding.fetch(`https://internal${publishPath}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
          }
        },
      };
    },
    track(promise: Promise<unknown>) {
      pending.push(promise);
    },
    async drain(): Promise<SideEffects> {
      while (pending.length > 0) await Promise.allSettled(pending.splice(0));
      lastMail = mail.take();
      return {
        events: effects.events.splice(0),
        realtime: effects.realtime.splice(0),
        mail: lastMail.map((m) => mailRecord(m.email)),
      };
    },
    /** The emails the last `drain()` reported, with their transports. */
    lastMail(): SentByTypeScript[] {
      return lastMail;
    },
    /** Give the test Rust's mail in place of TypeScript's. */
    adoptMail(typescript: SentByTypeScript[], rust: RustMail[]): void {
      mail.adopt(typescript, rust);
    },
  };
}

export type SideEffectRecorder = ReturnType<typeof createSideEffectRecorder>;

interface RustSideEffects {
  effects: SideEffects;
  mail: RustMail[];
}

export async function rustSideEffects(target: ConformanceTarget): Promise<RustSideEffects> {
  const response = await fetch(`${target.url}/__conformance/side-effects`);
  const body = (await response.json()) as Omit<SideEffects, 'mail'> & { mail?: RustMail[] };
  const mail = body.mail ?? [];
  return {
    effects: {
      events: body.events,
      realtime: body.realtime,
      mail: mail.map((m) =>
        mailRecord({
          ...m,
          replyTo: m.replyTo ?? undefined,
          attachments: m.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: new Uint8Array(Buffer.from(a.contentBase64, 'base64')),
          })),
        }),
      ),
    },
    mail,
  };
}

/** What the test's flag evaluator answers for every catalog flag, for Rust. */
async function flagValues(flags: unknown): Promise<Record<string, unknown> | undefined> {
  if (!flags || typeof flags !== 'object') return undefined;
  const evaluator = flags as {
    getValue?: (key: string) => Promise<unknown>;
    isOn?: (key: string) => Promise<boolean>;
  };
  const { FLAGS } = await import('@weldsuite/feature-flags/flags');
  const values: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(FLAGS)) {
    try {
      if (typeof evaluator.getValue === 'function') values[key] = await evaluator.getValue(key);
      else if (definition.type === 'boolean' && typeof evaluator.isOn === 'function') {
        values[key] = await evaluator.isOn(key);
      }
    } catch {
      // A stub that only knows some flags: the rest stay at their defaults.
    }
  }
  return values;
}

export interface ConformanceRequest {
  target: ConformanceTarget;
  ctx: ConformanceContext;
  env: Record<string, unknown>;
  input: string;
  init: RequestInit | undefined;
  /** Run the request on the Hono app, against `tenantDb`, with `env` in place of the test's when given. */
  runTypeScript: (
    tenantDb: Database,
    input: string,
    init?: RequestInit,
    env?: Record<string, unknown>,
  ) => Promise<Response>;
  /** The Hono app's recording bindings. */
  sideEffects: SideEffectRecorder;
  /**
   * More of the test's doubles for Rust, beside the context's databases, env
   * and buckets: the signer portal's KV namespace and Workflow binding
   * (`{ cache, jobs }`, bridge URLs).
   */
  context?: Record<string, unknown>;
  /** Response headers the two answers must agree on, besides status and body. */
  compareHeaders?: readonly string[];
  /**
   * Masks, in both runs' side effects, what differs between the backends by
   * construction for this caller only (a generated PDF's size).
   */
  normalizeEffects?: (effects: SideEffects) => SideEffects;
  /**
   * Where the Rust server serves the router under test, in front of the
   * test's path (`createTestApp`'s `rustBasePath`).
   */
  rustBasePath?: string;
}

// ── the shared database ─────────────────────────────────────────────────────

export type PGliteClient = NonNullable<ReturnType<typeof pgliteClientOf>>;

const servers = new Map<PGliteClient, Promise<string>>();

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** A Postgres URL for the test's pglite, starting its socket server once. */
export function databaseUrlFor(client: PGliteClient): Promise<string> {
  let url = servers.get(client);
  if (!url) {
    url = (async () => {
      const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
      const port = await freePort();
      // wireCompatiblePglite: one ReadyForQuery per Sync after a failed
      // statement, or the Rust connection falls out of step (./pglite-wire.ts).
      const server = new PGLiteSocketServer({
        db: wireCompatiblePglite(client) as never,
        port,
        host: '127.0.0.1',
        maxConnections: 8,
      });
      await server.start();
      process.once('beforeExit', () => void server.stop());
      // A unique name per database: the Rust server keys its pools by URL, and a
      // later test process may get the same port for a different database.
      const name = `conformance-${process.pid}-${port}-${Date.now().toString(36)}`;
      return `postgres://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable&application_name=${name}`;
    })();
    servers.set(client, url);
  }
  return url;
}

/** A drizzle handle on a copy of the test's database, for the TypeScript side of a write. */
export async function cloneDatabase(
  client: PGliteClient,
  kind: 'tenant' | 'master' = 'tenant',
): Promise<{ db: Database; close: () => Promise<void> }> {
  const [drizzlePg, schema] = await Promise.all([
    import('drizzle-orm/pglite'),
    kind === 'master' ? import('@weldsuite/db/schema/master') : import('@weldsuite/db/schema'),
  ]);
  const clone = await client.clone();
  const db = drizzlePg.drizzle(clone as never, { schema }) as unknown as Database;
  const closable = clone as unknown as { close: () => Promise<void>; mod?: unknown };
  return {
    db,
    close: async () => {
      await closable.close();
      // Let the copy's WebAssembly heap go even while something still holds the
      // copy: an entity-event spy's recorded calls keep the request context, and
      // so this database, for the rest of the file. Each write takes a full copy,
      // so without this a test file grows by one database per write.
      closable.mod = undefined;
    },
  };
}

/** The copy of the master database the TypeScript side of a write runs on, while it runs. */
let masterForTypeScript: Database | undefined;

/**
 * The master database a test's `getMasterDb` mock should hand out:
 * `vi.mock(..., () => ({ getMasterDb: () => conformanceMasterDb(master.db) }))`.
 *
 * The master database is shared with the Rust server like the tenant one, so
 * a write would otherwise run on TypeScript after Rust already changed it. For
 * the TypeScript side of a write this is a copy taken before Rust ran; at
 * every other moment (and outside conformance mode) it is `db` itself.
 */
export function conformanceMasterDb<T>(db: T): T {
  return (masterForTypeScript as T | undefined) ?? db;
}

/** The copy of the tenant database the TypeScript side of a write runs on, while it runs. */
let tenantForTypeScript: Database | undefined;

/**
 * The tenant database a test's `getTenantDbForWorkspace` mock should hand out,
 * for a route that opens the workspace's database itself instead of taking
 * the context's: `getTenantDbForWorkspace: async () => conformanceTenantDb(tenant.db)`.
 * Like {@link conformanceMasterDb}: the copy the TypeScript side of a write
 * runs on while it runs, `db` itself at every other moment.
 */
export function conformanceTenantDb<T>(db: T): T {
  return (tenantForTypeScript as T | undefined) ?? db;
}

// ── comparison ──────────────────────────────────────────────────────────────

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** A WeldSign signing link (`<portal>/r/<token>`): the token is 32 random bytes, new per run. */
const SIGN_LINK = /\/r\/[A-Za-z0-9_-]{43}$/;
/** A WeldBooks W-9 request link (`<platform>/w9/<token>`): the token is 32 random bytes, new per run. */
const W9_LINK = /\/w9\/[A-Za-z0-9_-]{43}$/;
/** The random segment of a chat attachment's object key. */
const CHAT_FILE_SEGMENT = /\/files\/[0-9a-f]{32}\//g;
/** A generated id in a link: a path segment or a parameter value. */
const LINKED_ID = /([/=])[a-z][a-z0-9]*_[0-9a-z]{12,}(?=[/?&#]|$)/g;
/** A slug ending in a generated id (`-ch_<base36>`). */
const SLUG_WITH_ID = /-[a-z][a-z0-9]*_[0-9a-z]{12,}$/;
/** A SHA-256 in hex. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A WeldSign signer session: base64url JSON payload, then its HMAC-SHA-256. */
const SIGNER_SESSION = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
/** `generateId()` output: a prefix, `_`, base36 time and randomness. */
const GENERATED_ID = /^[a-z][a-z0-9]*_[0-9a-z]{12,}$/;
/** A WeldDesk helpdesk mail account id: `helpdesk_` and a generated id (`helpdesk_hd_<id>`). */
const HELPDESK_ACCOUNT_ID = /^helpdesk_[a-z][a-z0-9]*_[0-9a-z]{12,}$/;
/**
 * `Date.now()` inside a string (a storage key, a URL): 13 digits from 2001 to
 * 2286, not part of a longer number. Differs between two runs of a write.
 */
const EPOCH_MS = /(?<!\d)1\d{12}(?!\d)/g;
/** An API key's display prefix (`wsk_` and the random key's first 8 hex characters). */
const API_KEY_PREFIX = /^wsk_[0-9a-f]{8}$/;
/**
 * A random token in hex (16 random bytes, e.g. an SSO domain's TXT record
 * value), on its own or inside a string. New on every run of a write.
 */
const RANDOM_HEX = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g;
/** An upload token (`upl_` and 32 random characters), alone or in a URL. */
const UPLOAD_TOKEN = /\bupl_[A-Za-z0-9]{32}\b/g;
/**
 * The generated id in a WeldDesk agent file's object name
 * (`<Date.now()>_att_<id>_<file name>`), in its URL and its event's entityId.
 */
const DESK_ATTACHMENT_ID = /_att_[0-9a-z]{12,}_/g;
/** The `<Date.now()>_<random UUID hex>` segment of a new upload's object key. */
const UPLOAD_KEY_SEGMENT = /\/\d{13}_[0-9a-f]{32}\//g;
/** A signed object URL's credential (`?exp=<seconds>&sig=<HMAC>`). */
const SIGNED_URL_QUERY = /\?exp=\d+&sig=[\w-]+$/;
/**
 * A ticket or conversation number WeldDesk generates (`TKT-` or `CONV-` and
 * `Date.now()` in base 36, and a
 * random `-<4 characters>` on `POST /api/tickets`): new per run.
 */
const GENERATED_TICKET_NUMBER = /^(TKT|CONV)-[0-9A-Z]{8}(-[0-9A-Z]{4})?$/;
/**
 * A custom WeldFlow pipeline stage's id (`slugifyStage`): a slug of its name,
 * `_`, and 4 random base36 characters, new per run by construction. A stage
 * created without a system status uses its id as one.
 */
const STAGE_SLUG_ID = /^[a-z0-9](?:[a-z0-9_]{0,23}[a-z0-9])?_[0-9a-z]{4}$/;
const STAGE_SLUG_KEYS = new Set(['id', 'entityId', 'systemStatus']);
/** Seconds either side of now an `expiresAt` may be, to count as one minted by the request. */
const EXPIRY_WINDOW_SECONDS = 2 * 24 * 60 * 60;
/**
 * A fresh RFC 5322 Message-ID a send minted (`<32 random hex@sender domain>`,
 * `buildRfc5322`'s `generateMessageId`): new per run by construction. The
 * domain is kept; the parsed messages are compared as side effects too.
 */
const FRESH_MESSAGE_ID = /^<[0-9a-f]{32}@([^>]+)>$/;

/** A `Date.now()` taken within two days of now. */
function isRecentEpochMs(value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  return Math.abs(value - Date.now()) <= EXPIRY_WINDOW_SECONDS * 1000;
}


/** A Unix-seconds expiry the request minted (signed URLs, the files cookie). */
function isMintedExpiry(value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  return Math.abs(value - Math.floor(Date.now() / 1000)) <= EXPIRY_WINDOW_SECONDS;
}

/**
 * Sorted keys, and for writes the values that differ by construction between
 * two runs replaced by placeholders: new ids, timestamps, cursors, upload
 * tokens and the random segment of an upload's key, and what a signing
 * route derives from the current second (an `expiresAt` near now, a signed
 * URL's `exp` and `sig`). Reads run on the same rows, so they are compared
 * exactly; a signature the Rust run minted is still checked, by the reads
 * that use it, which both backends verify.
 */
export function normalizeForDiff(value: unknown, isWrite: boolean, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForDiff(item, isWrite));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, normalizeForDiff((value as Record<string, unknown>)[k], isWrite, k)]),
    );
  }
  // A realtime room payload's `ts: Date.now()`.
  if (isWrite && key === 'ts' && typeof value === 'number' && Number.isInteger(value) && value >= 1e12 && value < 1e13) {
    return '<epoch-ms>';
  }
  if (isWrite && typeof value === 'string') return normalizeWrittenString(value, key);
  if (isWrite && key === 'expiresAt' && isMintedExpiry(value)) return '<expires-at>';
  // A realtime room message's `ts: Date.now()` (`RealtimePublisher#chatMessage`),
  // stamped when each run publishes.
  if (isWrite && key === 'ts' && isRecentEpochMs(value)) return '<epoch-ms>';
  return value;
}

/** A string in a write's answer, with what differs per run by construction replaced. */
function normalizeWrittenString(value: string, key: string | undefined): string {
  if (key === 'cursor') return '<cursor>';
  if (GENERATED_TICKET_NUMBER.test(value)) return `${value.split('-')[0]}-<generated>`;
  return normalizeSignedValue(value, key) ?? normalizeGeneratedValue(value, key) ?? normalizeRandomParts(value);
}

/** Credentials and digests a write answers with, by their key; undefined when none applies. */
function normalizeSignedValue(value: string, key: string | undefined): string | undefined {
  // WeldSign's signed PDF: pdf-lib and lopdf write different bytes for the
  // same drawn content (object numbers, number formatting, compression), so
  // its SHA-256 differs by construction. It reaches a side effect only in
  // `sign_envelope:completed` (the finalize job); the drawn content is
  // checked by rust/modules/sign's tests against pdf-lib's output.
  if (key === 'finalSha256' && SHA256_HEX.test(value)) return '<sha256>';
  // A signer session carries its expiry, the run's clock plus two hours.
  if (key === 'session' && SIGNER_SESSION.test(value)) return '<session>';
  // "Sign now" answers a fresh link, new per run by construction.
  if (key === 'url' && SIGN_LINK.test(value)) return value.replace(SIGN_LINK, '/r/<token>');
  if (key === 'url' && W9_LINK.test(value)) return value.replace(W9_LINK, '/w9/<token>');
  if (key === 'keyPrefix' && API_KEY_PREFIX.test(value)) return '<key-prefix>';
  return undefined;
}

/** Timestamps, generated ids and the links and slugs that carry one; undefined when none applies. */
function normalizeGeneratedValue(value: string, key: string | undefined): string | undefined {
  if (ISO_TIMESTAMP.test(value)) return '<timestamp>';
  if (FRESH_MESSAGE_ID.test(value)) return value.replace(FRESH_MESSAGE_ID, '<message-id@$1>');
  if (GENERATED_ID.test(value)) return '<id>';
  if (HELPDESK_ACCOUNT_ID.test(value)) return 'helpdesk_<id>';
  // A taken channel slug gets the new channel's id appended
  // (`resolveChannelSlug`): `sales-ch_<id>`.
  if (key === 'slug' && SLUG_WITH_ID.test(value)) return value.replace(SLUG_WITH_ID, '-<id>');
  // A notification's link to what the request just created
  // (`/weldchat/dm/ch_<id>`, `?messageId=msg_<id>`).
  if (key === 'actionUrl') return value.replace(LINKED_ID, '$1<id>');
  // A realtime publish to a room the request just created (`/publish/chat/ch_<id>`).
  if (key === 'path' && value.startsWith('/publish/')) return value.replace(LINKED_ID, '$1<id>');
  if (key !== undefined && STAGE_SLUG_KEYS.has(key) && STAGE_SLUG_ID.test(value)) return '<stage-id>';
  return undefined;
}

/** Random segments anywhere in a string. */
function normalizeRandomParts(value: string): string {
  // Storage: upload tokens, an upload key's random segment and a signed
  // URL's credential; then 16-byte hex tokens (an SSO domain's TXT value) and
  // any other `Date.now()` (the key's segment holds one).
  return value
    .replace(UPLOAD_TOKEN, '<upload-token>')
    .replace(UPLOAD_KEY_SEGMENT, '/<time>_<random>/')
    // A WeldChat attachment's key: `…/files/<32 random hex>/<name>`.
    .replace(CHAT_FILE_SEGMENT, '/files/<random>/')
    .replace(DESK_ATTACHMENT_ID, '_att_<id>_')
    .replace(SIGNED_URL_QUERY, '?exp=<expires-at>&sig=<signature>')
    .replace(RANDOM_HEX, '<hex>')
    .replace(EPOCH_MS, '<epoch-ms>');
}

/** The first place two normalised JSON values differ, as a path and both values; null when equal. */
export function firstDifference(a: unknown, b: unknown, at = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) return firstArrayDifference(a, b, at);
  if (isPlainObject(a) && isPlainObject(b)) return firstObjectDifference(a, b, at);
  return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstArrayDifference(a: unknown[], b: unknown[], at: string): string | null {
  if (a.length !== b.length) return `${at}: ${a.length} items vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    const diff = firstDifference(a[i], b[i], `${at}[${i}]`);
    if (diff) return diff;
  }
  return null;
}

function firstObjectDifference(a: Record<string, unknown>, b: Record<string, unknown>, at: string): string | null {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const diff = firstDifference(a[key], b[key], `${at}.${key}`);
    if (diff) return diff;
  }
  return null;
}

interface Captured {
  status: number;
  headers: Headers;
  /** The body as it came: a PDF is not text. */
  bytes: Uint8Array;
  text: string;
  json: unknown;
}

async function capture(response: Response): Promise<Captured> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: unknown;
  if ((response.headers.get('content-type') ?? '').includes('json') && text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, headers: response.headers, bytes, text, json };
}

// ── recording ───────────────────────────────────────────────────────────────

export interface ConformanceRecord {
  file: string | undefined;
  test: string | undefined;
  method: string;
  path: string;
  /** The Hono route pattern that answered (`/api/companies/:id`). */
  route: string | null;
  tsStatus: number;
  /** null in record-only mode. */
  rustStatus: number | null;
  match: boolean;
  difference: string | null;
  schema: 'ok' | 'fail' | 'none';
  schemaError: string | null;
}

export async function currentTest(): Promise<{ file?: string; test?: string }> {
  try {
    const { expect } = await import('vitest');
    const state = expect.getState();
    return { file: state.testPath, test: state.currentTestName };
  } catch {
    return {};
  }
}

async function appendLines(dir: string, lines: readonly unknown[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dir, { recursive: true });
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  await appendFile(path.join(dir, `conformance-${process.pid}.jsonl`), text);
}

export async function record(dir: string, entry: ConformanceRecord): Promise<void> {
  await appendLines(dir, [{ kind: 'request', ...entry }]);
}

/**
 * Record the routes of an app under test, so the coverage report can list the
 * ones no test reaches. Called once per `createTestApp()` in conformance mode.
 */
export async function recordInventory(
  target: ConformanceTarget,
  routes: ReadonlyArray<{ method: string; path: string }>,
): Promise<void> {
  if (!target.reportDir) return;
  const { file } = await currentTest();
  await appendLines(
    target.reportDir,
    routes.filter((r) => r.method !== 'ALL').map((r) => ({ kind: 'inventory', file, method: r.method, route: r.path })),
  );
}

/** Record-only mode: run on the Hono app and note the route and status. */
export async function recordOnlyRequest(
  target: ConformanceTarget,
  method: string,
  input: string,
  run: () => Promise<Response>,
): Promise<Response> {
  const response = await run();
  if (target.reportDir) {
    const { file, test } = await currentTest();
    const route = response.headers.get(ROUTE_HEADER);
    // TypeScript's own answer against the route's registered schema, so a
    // schema written for a module being ported is checked before Rust runs.
    const { schema, schemaError } = checkSchema(method.toUpperCase(), route, await capture(response.clone()));
    await record(target.reportDir, {
      file,
      test,
      method: method.toUpperCase(),
      path: pathOf(input),
      route,
      tsStatus: response.status,
      rustStatus: null,
      match: true,
      difference: null,
      schema,
      schemaError,
    });
  }
  return response;
}

// ── the request ─────────────────────────────────────────────────────────────

/** The origin a request is addressed to: its own for an absolute URL, `http://localhost` for a path. */
function originOf(input: string): URL {
  return new URL(/^https?:\/\//.test(input) ? input : 'http://localhost/');
}

function pathOf(input: string): string {
  if (/^https?:\/\//.test(input)) {
    const url = new URL(input);
    return `${url.pathname}${url.search}`;
  }
  return input;
}

/** The URL the master pglite is served at, when the test has one. */
async function masterDatabaseUrl(masterDb: Database | undefined): Promise<string | null> {
  const client = masterDb ? pgliteClientOf(masterDb) : undefined;
  return client ? databaseUrlFor(client) : null;
}

/** The URLs other workspaces' tenant pglites are served at, by reference. */
async function tenantDatabaseUrls(tenantDbs: Record<string, Database> | undefined): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  for (const [reference, db] of Object.entries(tenantDbs ?? {})) {
    const client = pgliteClientOf(db);
    if (client) urls[reference] = await databaseUrlFor(client);
  }
  return urls;
}

/** The test's context as the Rust server's conformance mode reads it. */
async function testContext(ctx: ConformanceContext, env: Record<string, unknown>, databaseUrl: string) {
  return {
    userId: ctx.userId,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    clerkOrgId: ctx.clerkOrgId,
    sessionId: ctx.sessionId,
    factorVerificationAge: ctx.factorVerificationAge ?? null,
    databaseUrl,
    masterDatabaseUrl: await masterDatabaseUrl(ctx.masterDb),
    tenantDatabaseUrls: await tenantDatabaseUrls(ctx.tenantDbs),
    permissions: ctx.permissions,
    flags: await flagValues(ctx.flags),
    appAccess: ctx.appAccess ?? null,
    env: forwardedEnv(env),
    // The test's buckets, served over HTTP so Rust shares their objects.
    files: await bucketUrls(env),
    // And its KV namespace, so Rust shares its keys.
    kv: await kvUrls(env),
    // Third-party calls (Clerk, …) go through the test's own `fetch` stub.
    outbound: await outboundBridgeUrl(),
    // Presence reads go to the test's `REALTIME` binding (./realtime-bridge.ts).
    realtime: (await realtimeUrl(env)) ?? null,
    // Customer mail through its `SEND_EMAIL` stub, guard calls to its ledgers.
    sendEmail: await sendEmailUrl(env),
    ledgers: await ledgerUrls(env),
    // Its Workflow bindings (runs started and woken).
    workflows: await workflowUrls(env),
    // Its service bindings (`BOOKS_INTERNAL`).
    services: await serviceBindingUrls(env),
  };
}

interface Runs {
  ts: Captured;
  rust: Captured;
  tsEffects: SideEffects;
  rustEffects: SideEffects;
  /** The mail each side sent, to hand Rust's to the test afterwards. */
  tsMail: SentByTypeScript[];
  rustMail: RustMail[];
}

/**
 * Both runs from the same starting state: a read runs TypeScript and then
 * Rust on the test's database; a write runs TypeScript first on a copy of
 * it, with copy-on-write views of the buckets and KV, then Rust on the
 * real ones (the test's own assertions then see Rust's writes).
 */
async function runBoth(
  request: ConformanceRequest,
  client: PGliteClient,
  isWrite: boolean,
  runRust: () => Promise<Captured>,
  runTypeScript: (db: Database, env?: Record<string, unknown>) => Promise<Captured>,
): Promise<Runs> {
  // Start both recordings empty.
  await request.sideEffects.drain();
  await rustSideEffects(request.target);
  takeRustOutbound();
  takeRustSends();
  takeRustLedgerCalls();
  takeRustWorkflowCalls();
  takeRustServiceCalls();

  // The Hono app's run, its `waitUntil` work included, with its outbound calls,
  // its customer mail and its ledger calls.
  const typeScript = async (db: Database, env?: Record<string, unknown>) => {
    const base = env ?? request.env;
    const sends = recordTypeScriptSends(base);
    const ledger = recordTypeScriptLedgerCalls(sends.env);
    const workflows = recordTypeScriptWorkflowCalls(ledger.env);
    const services = recordTypeScriptServiceCalls(workflows.env);
    const { result, calls } = await recordOutbound(async () => {
      // The test's own env when there was nothing to wrap, as before.
      const ts = await runTypeScript(db, services.env === base ? env : services.env);
      return { ts, effects: await request.sideEffects.drain() };
    });
    return {
      ts: result.ts,
      tsEffects: {
        ...result.effects,
        events: sortEvents(result.effects.events),
        outbound: sortOutbound(calls),
        ...mailEffects(sends.finish(), ledger.finish()),
        ...workflowEffects(workflows.finish()),
        ...serviceEffects(services.finish()),
      },
      tsMail: request.sideEffects.lastMail(),
    };
  };
  // Rust's run; its outbound calls are what reached the bridge.
  const rustRun = async () => {
    const rust = await runRust();
    const side = await rustSideEffects(request.target);
    return {
      rust,
      rustEffects: {
        ...side.effects,
        events: sortEvents(side.effects.events),
        outbound: sortOutbound(takeRustOutbound()),
        ...mailEffects(takeRustSends(), takeRustLedgerCalls()),
        ...workflowEffects(takeRustWorkflowCalls()),
        ...serviceEffects(takeRustServiceCalls()),
      },
      rustMail: side.mail,
    };
  };

  if (!isWrite) {
    const ts = await typeScript(request.ctx.tenantDb);
    return { ...ts, ...(await rustRun()) };
  }
  const clone = await cloneDatabase(client);
  // The master database too, when the test has one: Rust writes the shared one.
  const masterClient = request.ctx.masterDb ? pgliteClientOf(request.ctx.masterDb) : undefined;
  const masterClone = masterClient ? await cloneDatabase(masterClient, 'master') : undefined;
  try {
    // TypeScript first, on the copies and on copy-on-write views of the
    // buckets and KV, so it starts from the state Rust then starts from.
    masterForTypeScript = masterClone?.db;
    tenantForTypeScript = clone.db;
    let ts: Awaited<ReturnType<typeof typeScript>>;
    try {
      ts = await typeScript(clone.db, isolatedEnv(request.env));
    } finally {
      masterForTypeScript = undefined;
      tenantForTypeScript = undefined;
    }
    return { ...ts, ...(await rustRun()) };
  } finally {
    await clone.close();
    await masterClone?.close();
  }
}

/** Customer mail and ledger calls as side effects, present only when there were any. */
function mailEffects(sends: SendRecord[], calls: LedgerCall[]): Pick<SideEffects, 'sendEmail' | 'ledger'> {
  return {
    ...(sends.length > 0 ? { sendEmail: sortSends(sends) } : {}),
    ...(calls.length > 0 ? { ledger: sortLedgerCalls(calls) } : {}),
  };
}

/**
 * Entity events sorted by their normalised form: both backends publish fire
 * and forget, so a request's events (a conversation updated and the ticket it
 * became) reach the bus in either order.
 */
function sortEvents(events: unknown[]): unknown[] {
  const key = (event: unknown) => JSON.stringify(normalizeForDiff(event, true));
  return [...events].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Workflow binding calls as a side effect, present only when there were any,
 * sorted by their normalised form: concurrent starts land in any order, and
 * an enrollment's id is new per run.
 */
function workflowEffects(calls: WorkflowCall[]): Pick<SideEffects, 'workflows'> {
  if (calls.length === 0) return {};
  const key = (call: WorkflowCall) => JSON.stringify(normalizeForDiff(call, true));
  return { workflows: [...calls].sort((a, b) => key(a).localeCompare(key(b))) };
}

/** Service binding calls as a side effect, present only when there were any. */
function serviceEffects(calls: ServiceCall[]): Pick<SideEffects, 'services'> {
  return calls.length > 0 ? { services: sortServiceCalls(calls) } : {};
}

/** Where the two runs differ: status, headers, body, then side effects; null when they match. */
function compareRuns(
  { ts, rust, tsEffects, rustEffects }: Runs,
  isWrite: boolean,
  method: string,
  route: string | null,
  options: Pick<ConformanceRequest, 'compareHeaders' | 'normalizeEffects'> = {},
): string | null {
  if (ts.status !== rust.status) return `status ${ts.status} (TypeScript) vs ${rust.status} (Rust)`;
  for (const name of options.compareHeaders ?? []) {
    const [a, b] = [ts.headers.get(name), rust.headers.get(name)];
    if (a !== b) return `header ${name}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  if (ts.json !== undefined || rust.json !== undefined) {
    // Values a route draws per run (./conformance-volatile.ts) are masked first.
    const body = firstDifference(
      normalizeForDiff(maskVolatile(method, route, ts.json), isWrite),
      normalizeForDiff(maskVolatile(method, route, rust.json), isWrite),
    );
    if (body) return body;
  } else if (!sameBody(route, ts.bytes, rust.bytes)) {
    // PDFs by their drawing, generated files without the moment they were made (./conformance-binary.ts).
    return 'response bodies differ';
  }
  // New event ids and timestamps differ by construction, even on a read, and
  // so does what a route draws per run where its events carry it.
  const own = options.normalizeEffects ?? ((effects: SideEffects) => effects);
  const prepare = (effects: SideEffects) => {
    const normalized = own(effects);
    return { ...normalized, events: maskVolatileEvents(method, route, normalized.events) };
  };
  const effects = firstDifference(normalizeForDiff(prepare(tsEffects), true), normalizeForDiff(prepare(rustEffects), true));
  return effects ? `side effects: ${effects}` : null;
}

/** Rust's successful body against the route's registered Zod schema. */
function checkSchema(
  method: string,
  route: string | null,
  rust: Captured,
): Pick<ConformanceRecord, 'schema' | 'schemaError'> {
  const validator = route ? schemaFor(method, route) : undefined;
  if (!validator || rust.status >= 300 || rust.json === undefined) return { schema: 'none', schemaError: null };
  const error = validator(rust.json);
  return { schema: error === null ? 'ok' : 'fail', schemaError: error };
}

/**
 * A body both runs can send: text as it is, anything else (a multipart
 * `FormData`, a `Blob`, bytes) serialised once, so both get the same bytes
 * and the same multipart boundary, which goes into `headers`.
 */
async function replayableBody(body: BodyInit | null | undefined, headers: Headers): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  const serialised = new Request('https://conformance.local/', { method: 'POST', body });
  const type = serialised.headers.get('content-type');
  if (type && !headers.has('content-type')) headers.set('content-type', type);
  return new Uint8Array(await serialised.arrayBuffer());
}

/**
 * The conformance request in flight. Requests a test fires at once
 * (`Promise.all`) run one after the other here: each one runs on both
 * backends and reads its side effects from recorders the two share, so
 * overlapping requests could not tell their events apart.
 */
let inFlight: Promise<unknown> = Promise.resolve();

/** Run one test request against Rust and TypeScript, compare, and return Rust's response. */
export function conformanceRequest(request: ConformanceRequest): Promise<Response> {
  const run = inFlight.then(() => runConformanceRequest(request));
  inFlight = run.catch(() => undefined);
  return run;
}

async function runConformanceRequest(request: ConformanceRequest): Promise<Response> {
  const { target, ctx, env, init } = request;
  const input = pathOf(request.input);
  const method = (init?.method ?? 'GET').toUpperCase();
  const isWrite =
    !SAFE_METHODS.has(method) ||
    WRITING_READS.some((re) => re.test(input)) ||
    new Headers(init?.headers).has(CONFORMANCE_WRITE_HEADER);

  const client = pgliteClientOf(ctx.tenantDb);
  if (!client) {
    throw new Error(
      'Conformance mode needs a pglite tenantDb (createPgliteDb()): this test uses a mock database, which the Rust server cannot reach.',
    );
  }
  const context = { ...(await testContext(ctx, env, await databaseUrlFor(client))), ...request.context };

  // A request body can be read once: keep it as text or bytes for both runs.
  const headers = new Headers(init?.headers);
  const body = await replayableBody(init?.body, headers);
  const rustHeaders = new Headers(headers);
  rustHeaders.set(CONFORMANCE_HEADER, Buffer.from(JSON.stringify(context)).toString('base64'));
  // The Hono app sees the test's URL (`http://localhost/...` for a bare
  // path); tell Rust the same origin, as an ingress would, so URLs built
  // from it (private object URLs, the files cookie's `Secure`) match.
  const origin = originOf(request.input);
  rustHeaders.set('X-Forwarded-Host', origin.host);
  rustHeaders.set('X-Forwarded-Proto', origin.protocol.replace(/:$/, ''));
  const tsInput = /^https?:\/\//.test(request.input) ? request.input : input;

  const runs = await runBoth(
    request,
    client,
    isWrite,
    // A redirect is the answer, as `app.request` gives TypeScript's: never followed.
    () =>
      fetch(`${target.url}${request.rustBasePath ?? ''}${input}`, {
        ...init,
        method,
        headers: rustHeaders,
        body,
        redirect: 'manual',
      }).then(capture),
    (db, runEnv) => request.runTypeScript(db, tsInput, { ...init, method, headers, body }, runEnv).then(capture),
  );
  const { ts, rust } = runs;
  // The test reads Rust's mail, as it reads Rust's response.
  request.sideEffects.adoptMail(runs.tsMail, runs.rustMail);
  // And a REALTIME stub of its own keeps Rust's publishes.
  const ownRealtime = request.env.REALTIME as
    | { testOwned?: boolean; deliver?: (published: SideEffects['realtime']) => Promise<void> }
    | undefined;
  if (ownRealtime?.testOwned && ownRealtime.deliver) await ownRealtime.deliver(runs.rustEffects.realtime);
  const route = ts.headers.get(ROUTE_HEADER);
  // A router Rust serves under a prefix registers its schemas and volatile
  // fields at the prefixed route, so they never meet a module's own route
  // of the same path (the widget's `/api/conversations` vs desk-api's).
  const registered = route && request.rustBasePath ? `${request.rustBasePath}${route}` : route;
  const difference = compareRuns(runs, isWrite, method, registered, request);
  const { schema, schemaError } = checkSchema(method, registered, rust);

  if (target.reportDir) {
    const { file, test } = await currentTest();
    await record(target.reportDir, {
      file,
      test,
      method,
      path: input,
      route,
      tsStatus: ts.status,
      rustStatus: rust.status,
      match: difference === null,
      difference,
      schema,
      schemaError,
    });
  }

  if (target.strict && (difference || schemaError)) {
    throw new Error(
      `Conformance: ${method} ${input} differs between TypeScript and Rust: ${difference ?? schemaError}\n` +
        `TypeScript: ${ts.status} ${ts.text.slice(0, 500)}\nRust: ${rust.status} ${rust.text.slice(0, 500)}`,
    );
  }

  const nullBody = [101, 204, 205, 304].includes(rust.status);
  return new Response(nullBody ? null : rust.bytes, { status: rust.status, headers: rust.headers });
}
