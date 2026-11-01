/**
 * The conformance harness's socket server after a statement fails: the
 * pipelined extended-protocol sequences sqlx sends (Parse/Describe/Sync to
 * prepare, Bind/Execute/Close/Sync to run), over a real socket, must get one
 * ReadyForQuery per Sync, so the next query on the same connection works.
 */

import { createConnection, createServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { wireCompatiblePglite, withoutReadyForQuery } from './pglite-wire';

// ── frontend messages ───────────────────────────────────────────────────────

const encoder = new TextEncoder();

function frame(type: string | null, body: number[]): Buffer {
  const head = type === null ? [] : [type.codePointAt(0) ?? 0];
  const length = 4 + body.length;
  return Buffer.from([...head, (length >>> 24) & 255, (length >> 16) & 255, (length >> 8) & 255, length & 255, ...body]);
}
const cstr = (text: string) => [...encoder.encode(text), 0];
const int16 = (n: number) => [(n >> 8) & 255, n & 255];
const int32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];

const startup = () => frame(null, [...int32(196608), ...cstr('user'), ...cstr('postgres'), ...cstr('database'), ...cstr('postgres'), 0]);
const parse = (name: string, sql: string) => frame('P', [...cstr(name), ...cstr(sql), ...int16(0)]);
const describeStatement = (name: string) => frame('D', [0x53, ...cstr(name)]);
const bind = (statement: string, params: string[]) =>
  frame('B', [
    ...cstr(''),
    ...cstr(statement),
    ...int16(0),
    ...int16(params.length),
    ...params.flatMap((param) => {
      const bytes = [...encoder.encode(param)];
      return [...int32(bytes.length), ...bytes];
    }),
    ...int16(0),
  ]);
const execute = () => frame('E', [...cstr(''), ...int32(0)]);
const closePortal = () => frame('C', [0x50, ...cstr('')]);
const sync = () => frame('S', []);
const query = (sql: string) => frame('Q', cstr(sql));

// ── a minimal wire client ───────────────────────────────────────────────────

/** Backend message types as letters, `Z(I)` style for ReadyForQuery. */
class WireClient {
  private buffer = Buffer.alloc(0);
  private messages: string[] = [];
  private waiter: (() => void) | null = null;
  /** The fields of the last ErrorResponse, for a failure message. */
  lastError = '';

  constructor(private readonly socket: Socket) {
    socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      while (this.buffer.length >= 5) {
        const end = 1 + this.buffer.readInt32BE(1);
        if (this.buffer.length < end) break;
        const type = String.fromCodePoint(this.buffer[0] ?? 0);
        if (type === 'E') this.lastError = this.buffer.subarray(5, end).toString('utf8').replaceAll('\0', ' ').trim();
        // ParameterStatus and NoticeResponse may come at any time; sqlx skips them too.
        if (type !== 'S' && type !== 'N') {
          this.messages.push(type === 'Z' ? `Z(${String.fromCodePoint(this.buffer[5] ?? 0)})` : type);
        }
        this.buffer = this.buffer.subarray(end);
      }
      this.waiter?.();
    });
  }

  /** Send `frames` in one write and collect the reply up to `syncs` ReadyForQuery messages, plus anything that trails them. */
  async roundTrip(frames: Buffer[], syncs: number): Promise<string[]> {
    this.messages = [];
    this.socket.write(Buffer.concat(frames));
    while (this.messages.filter((m) => m.startsWith('Z')).length < syncs) {
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    // A stray ReadyForQuery would arrive in the same flush; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return this.messages;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

let db: PGlite;
let server: PGLiteSocketServer;
let socket: Socket;
let client: WireClient;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create table wire_t (id text primary key); insert into wire_t values ('a');");
  const port = await freePort();
  server = new PGLiteSocketServer({ db: wireCompatiblePglite(db) as never, port, host: '127.0.0.1' });
  await server.start();
  socket = createConnection({ port, host: '127.0.0.1' });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  client = new WireClient(socket);
  const greeting = await client.roundTrip([startup()], 1);
  expect(greeting.at(-1)).toBe('Z(I)');
}, 60_000);

afterAll(async () => {
  socket?.destroy();
  await server?.stop();
  await db?.close();
});

describe('pglite over the wire after a failed statement', () => {
  it('a unique violation on Execute, then the next query on the same connection', async () => {
    // Prepare the insert (sqlx: Parse, Describe Statement, Sync).
    expect(await client.roundTrip([parse('sqlx_s_1', 'insert into wire_t values ($1)'), describeStatement('sqlx_s_1'), sync()], 1)).toEqual(['1', 't', 'n', 'Z(I)']);

    // Run it with a duplicate key (sqlx: Bind, Execute, Close portal, Sync).
    const failed = await client.roundTrip([bind('sqlx_s_1', ['a']), execute(), closePortal(), sync()], 1);
    expect(failed).toEqual(['2', 'E', 'Z(I)']);

    // The next prepare must start with ParseComplete, not a stale ReadyForQuery.
    expect(await client.roundTrip([parse('sqlx_s_2', 'select id from wire_t'), describeStatement('sqlx_s_2'), sync()], 1)).toEqual(['1', 't', 'T', 'Z(I)']);
    expect(await client.roundTrip([bind('sqlx_s_2', []), execute(), closePortal(), sync()], 1)).toEqual(['2', 'D', 'C', '3', 'Z(I)']);
  });

  it('a Parse that fails, then the next query', async () => {
    expect(await client.roundTrip([parse('sqlx_s_3', 'selec 1'), describeStatement('sqlx_s_3'), sync()], 1)).toEqual(['E', 'Z(I)']);
    expect(await client.roundTrip([parse('sqlx_s_4', 'select 1'), describeStatement('sqlx_s_4'), sync()], 1)).toEqual(['1', 't', 'T', 'Z(I)']);
  });

  it('inside a transaction the one ReadyForQuery reports the failed transaction', async () => {
    expect(await client.roundTrip([query('begin')], 1)).toEqual(['C', 'Z(T)']);
    expect(await client.roundTrip([bind('sqlx_s_1', ['a']), execute(), closePortal(), sync()], 1)).toEqual(['2', 'E', 'Z(E)']);
    expect(await client.roundTrip([query('rollback')], 1)).toEqual(['C', 'Z(I)']);
    const after = await client.roundTrip([bind('sqlx_s_2', []), execute(), closePortal(), sync()], 1);
    expect(after, client.lastError).toEqual(['2', 'D', 'C', '3', 'Z(I)']);
  });

  it('a simple query that fails keeps its ReadyForQuery', async () => {
    expect(await client.roundTrip([query("insert into wire_t values ('a')")], 1)).toEqual(['E', 'Z(I)']);
    expect(await client.roundTrip([query('select 1')], 1)).toEqual(['T', 'D', 'C', 'Z(I)']);
  });
});

describe('withoutReadyForQuery', () => {
  it('drops ReadyForQuery messages and keeps the rest byte for byte', () => {
    const error = Buffer.from([0x45, 0, 0, 0, 6, 0x4d, 0]);
    const ready = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
    expect(Buffer.from(withoutReadyForQuery(Buffer.concat([error, ready])))).toEqual(error);
    expect(withoutReadyForQuery(ready)).toHaveLength(0);
  });
});
