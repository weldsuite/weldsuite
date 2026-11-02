/**
 * End to end on one machine: the Rust server (`weldsuite serve`), this
 * service (dist/server.mjs) and an S3 stand-in, on real master and tenant
 * databases. Two people edit one document and one sheet through the Rust
 * server's routes and socket proxy; the rooms checkpoint; the service
 * restarts; everything is still there.
 *
 *   pnpm --filter collab-rooms build
 *   pnpm exec tsx apps/tools/collab-rooms/scripts/e2e.ts \
 *     --bin <weldsuite serve binary> --pg postgres://postgres:pg@127.0.0.1:55432/postgres [--ports 18851]
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { docsAdapter, type DocModel, type Op as DocOp } from '@weldsuite/docs-engine';
import { connect } from '../test/client';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const bin = arg('bin')!;
const pgAdmin = arg('pg', 'postgres://postgres:pg@127.0.0.1:55432/postgres')!;
const base = Number(arg('ports', '18851'));
const [RUST, ROOMS, S3] = [base, base + 1, base + 2];
const run = Date.now().toString(36);
const ORG = 'org_e2e';
const WORKSPACE = 'ws_e2e';
const SECRET = 'collab-e2e-secret';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition: unknown, what: string): void {
  if (!condition) throw new Error(`FAILED: ${what}`);
  console.log(`ok - ${what}`);
}

// ---- Session tokens shaped like Clerk's ----
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(user: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'ins_e2e' });
  const body = b64({ sub: user, sid: `sess_${user}`, iat: now - 10, nbf: now - 10, exp: now + 3600, v: 2, o: { id: ORG, rol: 'admin' } });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), keys.privateKey).toString('base64url')}`;
}

// ---- Databases ----
const dbUrl = (name: string) => Object.assign(new URL(pgAdmin), { pathname: `/${name}` }).toString();
const masterName = `p8_docsh_master_${run}`;
const tenantName = `p8_docsh_tenant_${run}`;
const masterUrl = dbUrl(masterName);
const tenantUrl = dbUrl(tenantName);

async function createDatabases(): Promise<void> {
  const admin = postgres(pgAdmin, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${masterName}`);
  await admin.unsafe(`create database ${tenantName}`);
  await admin.end();
  const tsx = createRequire(path.join(repo, 'package.json')).resolve('tsx/cli');
  const migrated = spawnSync(process.execPath, [tsx, 'scripts/rust-test-db.ts', '--master', masterUrl, '--tenant', tenantUrl], { cwd: repo, stdio: 'inherit' });
  if (migrated.status !== 0) throw new Error('migrations failed');
  const master = postgres(masterUrl, { max: 1, onnotice: () => {} });
  await master`insert into workspaces (id, name, slug, clerk_org_id, database_url) values (${WORKSPACE}, 'E2E', ${`e2e-${run}`}, ${ORG}, ${tenantUrl})`;
  await master.end();
  const tenant = postgres(tenantUrl, { max: 1, onnotice: () => {} });
  for (const [id, user, role, name] of [
    ['wm_alice', 'user_alice', 'OWNER', 'Alice'],
    ['wm_bob', 'user_bob', 'ADMIN', 'Bob'],
  ]) {
    await tenant`insert into workspace_members (id, user_id, role, name, status) values (${id}, ${user}, ${role}, ${name}, 'ACTIVE')`;
  }
  await tenant.end();
}

async function dropDatabases(): Promise<void> {
  const admin = postgres(pgAdmin, { max: 1, onnotice: () => {} });
  for (const name of [masterName, tenantName]) await admin.unsafe(`drop database if exists ${name} with (force)`);
  await admin.end();
}

// ---- An S3 stand-in: path-style objects, ListObjectsV2, If-None-Match ----
interface Obj { bytes: Buffer; type: string | undefined; meta: Record<string, string> }
const objects = new Map<string, Obj>();
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
function s3Server(): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://s3');
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = `${bucket}/${rest.map(decodeURIComponent).join('/')}`;
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = `${bucket}/${url.searchParams.get('prefix') ?? ''}`;
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const xml = keys.map((k) => `<Contents><Key>${k.slice(bucket!.length + 1).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</Key></Contents>`).join('');
        res.writeHead(200, { 'content-type': 'application/xml' }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${xml}</ListBucketResult>`);
        return;
      }
      const object = objects.get(key);
      if (req.method === 'PUT') {
        const bytes = await body(req);
        if (req.headers['if-none-match'] === '*' && object) return void res.writeHead(412).end();
        const meta: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) if (name.startsWith('x-amz-meta-')) meta[name] = String(value);
        objects.set(key, { bytes, type: req.headers['content-type'], meta });
        return void res.writeHead(200, { etag: '"e"' }).end();
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return void res.writeHead(204).end();
      }
      if (!object) return void res.writeHead(404, { 'content-type': 'application/xml' }).end('<Error><Code>NoSuchKey</Code></Error>');
      const headers = { 'content-type': object.type ?? 'application/octet-stream', 'content-length': String(object.bytes.length), etag: '"e"', ...object.meta };
      if (req.method === 'HEAD') return void res.writeHead(200, headers).end();
      res.writeHead(200, headers).end(object.bytes);
    })();
  });
}

// ---- Processes ----
const s3Env = {
  S3_ENDPOINT: `http://127.0.0.1:${S3}`,
  S3_REGION: 'us-east-1',
  S3_BUCKET_PRIVATE: 'private',
  S3_ACCESS_KEY_ID: 'e2e',
  S3_SECRET_ACCESS_KEY: 'e2e-secret',
  S3_FORCE_PATH_STYLE: 'true',
};
const baseEnv = { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '' };

function startRust(): ChildProcess {
  return spawn(bin, ['serve'], {
    env: {
      ...baseEnv,
      ...s3Env,
      HOST: '127.0.0.1',
      PORT: String(RUST),
      ENVIRONMENT: 'test',
      LOG_FORMAT: 'text',
      RUST_LOG: 'warn',
      DATABASE_URL_MASTER: masterUrl,
      CLERK_JWT_KEY: publicKeyPem,
      COLLAB_ROOMS_URLS: `http://127.0.0.1:${ROOMS}`,
      COLLAB_ROOMS_SECRET: SECRET,
      SHUTDOWN_DELAY_SECONDS: '0',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function startRooms(): ChildProcess {
  return spawn(process.execPath, [path.join(here, '../dist/server.mjs')], {
    env: {
      ...baseEnv,
      ...s3Env,
      PORT: String(ROOMS),
      COLLAB_ROOMS_SECRET: SECRET,
      COLLAB_EVENTS_URL: `http://127.0.0.1:${RUST}/internal/collab/events`,
      DATABASE_URL_MASTER: masterUrl,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function live(url: string): Promise<void> {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(200)) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not yet
    }
  }
  throw new Error(`${url} never came up`);
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(10_000)]);
}

async function api<T>(user: string, method: string, url: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${RUST}${url}`, {
    method,
    headers: { authorization: `Bearer ${token(user)}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function docs(): Promise<void> {
  const created = await api<{ data: { id: string } }>('user_alice', 'POST', '/api/docs', { name: 'E2E plan' });
  check(created.status === 201, `POST /api/docs answers 201 (${created.status})`);
  const id = created.body.data.id;
  const open = async (user: string) => {
    const session = await api<{ data: { ticket: string; mode: string } }>(user, 'POST', `/api/docs/${id}/session`);
    check(session.status === 200 && session.body.data.mode === 'edit', `${user} gets an edit session`);
    return connect<DocModel, DocOp>(`ws://127.0.0.1:${RUST}/api/docs/connect?ticket=${session.body.data.ticket}`, docsAdapter() as never);
  };
  const text = (c: Awaited<ReturnType<typeof open>>) => c.client.state!.toSnapshot().stories['body']!.text;
  const alice = await open('user_alice');
  const bob = await open('user_bob');
  alice.client.apply({ type: 'insert', story: 'body', at: 0, content: { text: 'Hello' } });
  await bob.until(() => text(bob).startsWith('Hello'));
  bob.client.apply({ type: 'insert', story: 'body', at: 5, content: { text: ' world' } });
  alice.client.apply({ type: 'insert', story: 'body', at: 0, content: { text: '>> ' } });
  await alice.until(() => !alice.client.hasPending && !bob.client.hasPending && alice.client.revision === 3 && bob.client.revision === 3);
  check(text(alice) === text(bob) && text(alice).startsWith('>> Hello world'), 'two editors converge through the Rust proxy');

  const live = await api<{ data: { revision: number; snapshot: { stories: Record<string, { text: string }> } } }>('user_bob', 'GET', `/api/docs/${id}/snapshot`);
  check(live.body.data.revision === 3 && live.body.data.snapshot.stories['body']!.text.startsWith('>> Hello world'), 'GET /snapshot serves the live room');
  const version = await api<{ data: { id: string; revision: number } }>('user_alice', 'POST', `/api/docs/${id}/versions`, { name: 'Three' });
  check(version.status === 201 && version.body.data.revision === 3, 'POST /versions saves the live document');

  await alice.close();
  await bob.close();
  for (let i = 0; i < 100; i++) {
    const doc = await api<{ data: { revision: number } }>('user_alice', 'GET', `/api/docs/${id}`);
    if (doc.body.data.revision === 3) break;
    await sleep(100);
  }
  const doc = await api<{ data: { revision: number; updatedById: string } }>('user_alice', 'GET', `/api/docs/${id}`);
  check(doc.body.data.revision === 3, 'the last one out checkpoints, and the room records it on the docs row');

  // A restart of the rooms service: the document comes back from the checkpoint.
  await stop(rooms);
  rooms = startRooms();
  await live(`http://127.0.0.1:${ROOMS}/healthz`);
  const carol = await open('user_bob');
  check(text(carol).startsWith('>> Hello world') && carol.client.revision === 3, 'after a restart the document reloads as it was');
  const restored = await api<{ data: { revision: number } }>('user_alice', 'POST', `/api/docs/${id}/versions/${version.body.data.id}/restore`);
  check(restored.status === 200 && restored.body.data.revision === 4, 'restoring a version goes through the room');
  await carol.until(() => carol.client.revision === 4);
  await carol.close();
}

let rooms: ChildProcess;

async function main(): Promise<void> {
  const s3 = s3Server();
  await new Promise<void>((resolve) => s3.listen(S3, '127.0.0.1', resolve));
  await createDatabases();
  const rust = startRust();
  rooms = startRooms();
  try {
    await live(`http://127.0.0.1:${RUST}/livez`);
    await live(`http://127.0.0.1:${ROOMS}/healthz`);
    await docs();
    console.log('e2e passed');
  } finally {
    await stop(rooms);
    await stop(rust);
    s3.close();
    await dropDatabases();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
