/**
 * Protocol parity of the Rust realtime gateway (rust/crates/realtime) with
 * the realtime-worker, driven by the clients the apps ship:
 * `WorkspaceClient` and `RoomClient` from `@weldsuite/realtime`, unchanged,
 * against two `weldsuite serve` processes ("pods") that share one Valkey.
 *
 *   pnpm exec tsx scripts/rust-realtime-parity.ts \
 *     --bin <path to the weldsuite binary> \
 *     --pg postgres://postgres:pg@127.0.0.1:5432/postgres \
 *     --valkey redis://127.0.0.1:6379 [--port 18731]
 *
 * It builds a master and a tenant database from the journaled migrations
 * (scripts/rust-test-db.ts) on the Postgres it is given (a pgvector image),
 * seeds one workspace with three members and a public chat channel, signs
 * Clerk-shaped session tokens with a key made for the run, and checks:
 * connect, auth refusals, subscribe, an event published on one pod reaching
 * subscribers on both with one eventId, personal topics, presence join, idle
 * and leave across pods, ping/pong, a pod going away and the client
 * reconnecting and replaying what it missed from its cursor, and a chat room
 * relaying typing, room presence and server messages between the pods.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createWriteStream, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { RoomClient } from '../packages/core/realtime/src/client/room-client';
import { WorkspaceClient } from '../packages/core/realtime/src/client/workspace-client';
import type { PresenceMember, WorkspaceEvent } from '../packages/core/realtime/src/types';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (!value) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return value;
}

const bin = path.resolve(argument('bin'));
const pgAdmin = argument('pg');
const valkey = argument('valkey');
const basePort = Number(argument('port', '18731'));
const ports = [basePort, basePort + 1] as const;
const run = `${process.pid}_${Date.now().toString(36)}`;
const secret = randomBytes(16).toString('hex');
const logs = mkdtempSync(path.join(tmpdir(), 'rt-parity-'));

const ORG = 'org_parity';
const WORKSPACE = 'ws_parity';
const CHANNEL = 'ch_parity';

// ---------------------------------------------------------------------------
// Session tokens, shaped like Clerk's
// ---------------------------------------------------------------------------

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function token(user: string, org: string | null = ORG, key = keys.privateKey): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'ins_parity' });
  const body = b64({
    sub: user,
    sid: `sess_${user}`,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 3600,
    v: 2,
    ...(org ? { o: { id: org, rol: 'member' } } : {}),
  });
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${signature}`;
}

// ---------------------------------------------------------------------------
// Databases
// ---------------------------------------------------------------------------

function databaseUrl(name: string): string {
  const url = new URL(pgAdmin);
  url.pathname = `/${name}`;
  return url.toString();
}

const masterName = `rt_parity_master_${run}`;
const tenantName = `rt_parity_tenant_${run}`;
const masterUrl = databaseUrl(masterName);
const tenantUrl = databaseUrl(tenantName);

async function createDatabases(): Promise<void> {
  const admin = postgres(pgAdmin, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${masterName}`);
    await admin.unsafe(`create database ${tenantName}`);
  } finally {
    await admin.end();
  }
  const tsx = createRequire(import.meta.url).resolve('tsx/cli');
  const migrated = spawnSync(
    process.execPath,
    [tsx, 'scripts/rust-test-db.ts', '--master', masterUrl, '--tenant', tenantUrl],
    { cwd: repo, stdio: 'inherit' },
  );
  if (migrated.status !== 0) throw new Error('migrations failed');

  const slug = `parity-${run}`;
  const master = postgres(masterUrl, { max: 1, onnotice: () => {} });
  try {
    await master`insert into workspaces (id, name, slug, clerk_org_id, database_url)
                 values (${WORKSPACE}, 'Parity', ${slug}, ${ORG}, ${tenantUrl})`;
  } finally {
    await master.end();
  }
  const tenant = postgres(tenantUrl, { max: 1, onnotice: () => {} });
  try {
    for (const [id, user, role, name] of [
      ['wm_admin', 'user_admin', 'ADMIN', 'Ada Admin'],
      ['wm_member', 'user_member', 'MEMBER', 'Max Member'],
      ['wm_viewer', 'user_viewer', 'VIEWER', 'Vic Viewer'],
    ]) {
      await tenant`insert into workspace_members (id, user_id, role, name, status)
                   values (${id}, ${user}, ${role}, ${name}, 'ACTIVE')`;
    }
    await tenant`insert into chat_channels (id, name, slug, type)
                 values (${CHANNEL}, 'general', 'general', 'public')`;
    await tenant`insert into chat_channels (id, name, slug, type)
                 values ('ch_private', 'private', 'private', 'private')`;
    await tenant`insert into chat_channel_members (id, channel_id, user_id)
                 values ('cm_member', 'ch_private', 'user_member')`;
  } finally {
    await tenant.end();
  }
}

async function dropDatabases(): Promise<void> {
  const admin = postgres(pgAdmin, { max: 1, onnotice: () => {} });
  try {
    for (const name of [masterName, tenantName]) {
      await admin.unsafe(`drop database if exists ${name} with (force)`);
    }
  } finally {
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// The two pods
// ---------------------------------------------------------------------------

const pods: (ChildProcess | null)[] = [null, null];

function startPod(index: 0 | 1): ChildProcess {
  const log = createWriteStream(path.join(logs, `pod-${index}.log`), { flags: 'a' });
  const child = spawn(bin, ['serve'], {
    env: {
      SystemRoot: process.env.SystemRoot ?? '',
      PATH: process.env.PATH ?? '',
      HOST: '127.0.0.1',
      PORT: String(ports[index]),
      ENVIRONMENT: 'test',
      LOG_FORMAT: 'text',
      RUST_LOG: 'info',
      DATABASE_URL_MASTER: masterUrl,
      CLERK_JWT_KEY: publicKeyPem,
      VALKEY_URL: valkey,
      VALKEY_REALTIME_PREFIX: `rt-parity:${run}:`,
      VALKEY_CACHE_PREFIX: `rt-parity-cache:${run}:`,
      REALTIME_INTERNAL_SECRET: secret,
      SHUTDOWN_DELAY_SECONDS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  pods[index] = child;
  return child;
}

async function waitUntilLive(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/livez`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await sleep(200);
  }
  throw new Error(`pod on ${port} did not come up (logs in ${logs})`);
}

function stopPod(index: 0 | 1): Promise<void> {
  const child = pods[index];
  pods[index] = null;
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const wsUrl = (index: 0 | 1, pathname: string) => `ws://127.0.0.1:${ports[index]}${pathname}`;

function workspaceClient(index: 0 | 1, user: string): WorkspaceClient {
  return new WorkspaceClient({ url: wsUrl(index, '/ws'), getToken: async () => token(user) });
}

/** The status an upgrade request is answered with. */
function upgradeStatus(index: 0 | 1, pathname: string, upgrade = true): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: ports[index],
      path: pathname,
      headers: upgrade
        ? {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          }
        : {},
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

async function publish(index: 0 | 1, pathname: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${ports[index]}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `publish ${pathname}: ${await res.text()}`);
}

const results: { name: string; error?: unknown }[] = [];

async function check(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    results.push({ name });
    console.log(`  ok    ${name}`);
  } catch (error) {
    results.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${(error as Error).stack ?? error}`);
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

async function checks(): Promise<void> {
  const member = workspaceClient(0, 'user_member');
  const admin = workspaceClient(1, 'user_admin');
  const memberEvents: WorkspaceEvent[] = [];
  const adminEvents: WorkspaceEvent[] = [];
  const presence: WorkspaceEvent[] = [];

  await check('connect: the client gets `connected` on both pods', async () => {
    await member.connect();
    await admin.connect();
    assert.equal(member.connectionState, 'connected');
    assert.equal(admin.connectionState, 'connected');
  });

  await check('auth: refused upgrades answer 401/403/426 and the client keeps retrying', async () => {
    assert.equal(await upgradeStatus(0, '/ws'), 401, 'no token');
    assert.equal(await upgradeStatus(0, `/ws?token=${token('user_member', ORG, otherKeys.privateKey)}`), 401);
    assert.equal(await upgradeStatus(0, `/ws?token=${token('user_member', null)}`), 401, 'no organization');
    assert.equal(await upgradeStatus(0, `/ws?token=${token('user_stranger')}`), 403, 'not a member');
    assert.equal(await upgradeStatus(0, `/ws?token=${token('user_member', 'org_nobody')}`), 403);
    assert.equal(await upgradeStatus(0, '/ws', false), 426, 'not an upgrade');
    // The room gates, against the tenant database.
    assert.equal(await upgradeStatus(0, `/ws/chat/ch_private?token=${token('user_member')}`), 101);
    assert.equal(await upgradeStatus(0, `/ws/chat/ch_private?token=${token('user_admin')}`), 403);
    assert.equal(await upgradeStatus(0, `/ws/chat/ch_gone?token=${token('user_admin')}`), 403);
    assert.equal(await upgradeStatus(1, `/ws/conversation/conv_gone?token=${token('user_admin')}`), 403);
    assert.equal(await upgradeStatus(1, `/ws/support/${ORG}?token=${token('user_member')}`), 101);
    assert.equal(await upgradeStatus(1, `/ws/support/${WORKSPACE}?token=${token('user_member')}`), 101);
    assert.equal(await upgradeStatus(1, `/ws/support/org_other?token=${token('user_member')}`), 403);
    assert.equal(await upgradeStatus(1, `/ws/personal?token=${token('consumer_1', null)}`), 101);
    const refused = new WorkspaceClient({
      url: wsUrl(0, '/ws'),
      getToken: async () => token('user_member', ORG, otherKeys.privateKey),
    });
    const states: string[] = [];
    refused.onConnectionChange((state) => states.push(state));
    await refused.connect();
    refused.disconnect();
    assert.ok(!states.includes('connected'), states.join(','));
    assert.ok(states.includes('reconnecting'), states.join(','));
  });

  await check('subscribe: an event published on one pod reaches both, with one eventId', async () => {
    member.on('task', (event) => memberEvents.push(event));
    admin.on('task.t1', (event) => adminEvents.push(event));
    await sleep(300);
    await publish(1, '/publish/workspace', {
      workspaceId: WORKSPACE,
      topic: 'task.t1',
      event: 'updated',
      data: { id: 't1', title: 'Parity' },
      userId: 'user_admin',
    });
    await waitFor('the event on both pods', () => memberEvents.length === 1 && adminEvents.length === 1);
    assert.deepEqual(memberEvents[0].data, { id: 't1', title: 'Parity' });
    assert.equal(memberEvents[0].topic, 'task.t1');
    assert.equal(memberEvents[0].event, 'updated');
    assert.equal(memberEvents[0].userId, 'user_admin');
    assert.equal(memberEvents[0].eventId?.length, 16);
    assert.equal(memberEvents[0].eventId, adminEvents[0].eventId);
    assert.equal(member.cursor, memberEvents[0].eventId);
  });

  await check('personal topics: only their user gets them, without `_access`', async () => {
    const mine: WorkspaceEvent[] = [];
    member.on('notification.user_member', (event) => mine.push(event));
    await sleep(300);
    await publish(0, '/publish/workspace', {
      workspaceId: ORG,
      topic: 'notification.user_member',
      event: 'created',
      data: { id: 'n1', _access: { userIds: ['user_member'] } },
      userId: 'system',
    });
    await waitFor('the notification', () => mine.length === 1);
    assert.deepEqual(mine[0].data, { id: 'n1' });
  });

  await check('presence: snapshot, join, idle and leave across pods', async () => {
    admin.on('presence', (event) => presence.push(event));
    await waitFor('the snapshot', () => presence.some((event) => event.event === 'snapshot'));
    const snapshot = presence.find((event) => event.event === 'snapshot')!;
    assert.deepEqual(snapshot.data, { users: { user_member: 'online', user_admin: 'online' } });
    // What workers ask over HTTP (`RealtimePublisher.getPresence`).
    const res = await fetch(
      `http://127.0.0.1:${ports[0]}/internal/presence?workspaceId=${WORKSPACE}&userId=user_member`,
      { headers: { 'x-internal-secret': secret } },
    );
    assert.deepEqual(await res.json(), { users: { user_member: 'online' } });
    const refused = await fetch(`http://127.0.0.1:${ports[0]}/internal/presence?workspaceId=${WORKSPACE}`);
    assert.equal(refused.status, 403);

    const viewer = workspaceClient(0, 'user_viewer');
    await viewer.connect();
    const change = (live: string | null) => () =>
      presence.some(
        (event) =>
          event.event === 'connection_changed' &&
          (event.data as { userId: string }).userId === 'user_viewer' &&
          (event.data as { live: string | null }).live === live,
      );
    await waitFor('viewer online', change('online'));
    viewer.setPresence({ idle: true });
    await waitFor('viewer away', change('away'));
    viewer.disconnect();
    await waitFor('viewer offline after the grace period', change(null), 12_000);
  });

  await check('heartbeat: `ping` is answered with `pong`', async () => {
    const socket = new WebSocket(`${wsUrl(1, '/ws')}?token=${token('user_viewer')}`);
    const messages: string[] = [];
    socket.addEventListener('message', (event) => messages.push(String(event.data)));
    await waitFor('connected', () => messages.some((m) => m.includes('"connected"')));
    socket.send('{"type":"ping"}');
    await waitFor('pong', () => messages.includes('{"type":"pong"}'));
    socket.close();
  });

  await check('reconnect: a pod goes away; the client reconnects and replays what it missed', async () => {
    const states: string[] = [];
    member.onConnectionChange((state) => states.push(state));
    await stopPod(0);
    await waitFor('the client noticing', () => member.connectionState !== 'connected');
    for (const n of [2, 3]) {
      await publish(1, '/publish/workspace', {
        workspaceId: WORKSPACE,
        topic: `task.t${n}`,
        event: 'created',
        data: { id: `t${n}` },
        userId: 'user_admin',
      });
    }
    startPod(0);
    await waitUntilLive(ports[0]);
    await waitFor('the client back', () => member.connectionState === 'connected', 20_000);
    await waitFor('the replay', () => memberEvents.length === 3, 10_000);
    assert.deepEqual(
      memberEvents.map((event) => event.topic),
      ['task.t1', 'task.t2', 'task.t3'],
    );
    assert.ok(states.includes('reconnecting'), states.join(','));
  });

  await check('chat room: typing, room presence and server messages between pods', async () => {
    const roomUrl = (index: 0 | 1) => wsUrl(index, `/ws/chat/${CHANNEL}`);
    const here = new RoomClient({ url: roomUrl(0), getToken: async () => token('user_member') });
    const there = new RoomClient({ url: roomUrl(1), getToken: async () => token('user_admin') });
    await here.connect();
    await there.connect();
    let members: PresenceMember[] = [];
    there.onPresence((list) => {
      members = list;
    });
    const typing: string[] = [];
    there.onTyping((users) => typing.push(users.map((u) => u.userName).join(',')));
    const messages: { id: string; seq?: number }[] = [];
    there.on('message', (event) => messages.push(event));
    const mine: { id: string; seq?: number }[] = [];
    here.on('message', (event) => mine.push(event));

    here.startTyping();
    await waitFor('typing on the other pod', () => typing.includes('Max Member'));
    here.enterPresence({ status: 'reading' });
    await waitFor('room presence', () => members.some((m) => m.userId === 'user_member'));
    assert.deepEqual(members.find((m) => m.userId === 'user_member')?.data, { status: 'reading' });

    await publish(0, `/publish/chat/${CHANNEL}`, {
      type: 'message',
      id: 'm1',
      content: 'hello',
      senderId: 'user_admin',
      senderName: 'Ada Admin',
    });
    await waitFor('the message on both pods', () => messages.length === 1 && mine.length === 1);
    assert.equal(messages[0].id, 'm1');
    assert.ok(typeof messages[0].seq === 'number' && messages[0].seq > 0, 'numbered');
    assert.equal(messages[0].seq, mine[0].seq);

    const later = new RoomClient({ url: roomUrl(1), getToken: async () => token('user_viewer') });
    await later.connect();
    assert.equal(later.lastSeq, messages[0].seq, 'lastSeq on connect');
    assert.ok(later.presence.some((m) => m.userId === 'user_member'), 'presence on connect');

    here.disconnect();
    await waitFor('presence leave', () => !members.some((m) => m.userId === 'user_member'));
    there.disconnect();
    later.disconnect();
  });

  member.disconnect();
  admin.disconnect();
}

async function main(): Promise<void> {
  console.log(`realtime parity: pods on ${ports.join(', ')}, logs in ${logs}`);
  await createDatabases();
  try {
    startPod(0);
    startPod(1);
    await Promise.all(ports.map(waitUntilLive));
    await checks();
  } finally {
    await stopPod(0);
    await stopPod(1);
    await dropDatabases();
  }
  const failed = results.filter((result) => result.error);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  void Promise.all([stopPod(0), stopPod(1)]).finally(() => process.exit(1));
});
