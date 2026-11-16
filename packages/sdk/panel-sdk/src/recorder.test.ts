/**
 * The recording plugin's chunking and upload, with rrweb's `record()` faked:
 * each run emits Meta + FullSnapshot straight away, like rrweb does, and the
 * test emits the rest. Masking with the real rrweb is in recorder-masking.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_CHARS, createRecorder, gzip, KEEPALIVE_BYTES, type PanelRecorder } from './recorder';
import { recordingKey } from './storage';
import { defineOn, resetPage, HOST, TOKEN } from './test/harness';

type Emit = (e: { type: number; data: unknown; timestamp: number }) => void;

const rr = vi.hoisted(() => {
  const state = {
    runs: [] as Array<{ options: { emit: Emit } & Record<string, unknown>; stopped: boolean }>,
    full(emit: Emit) {
      const t = Date.now();
      emit({ type: 4, data: { href: 'https://shop.example.com/', width: 1280, height: 800 }, timestamp: t });
      emit({ type: 2, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } }, timestamp: t });
    },
  };
  return state;
});

vi.mock('@rrweb/record', () => {
  const record = Object.assign(
    (options: { emit: Emit }) => {
      const run = { options, stopped: false };
      rr.runs.push(run);
      rr.full(options.emit);
      return () => {
        run.stopped = true;
      };
    },
    {
      takeFullSnapshot: () => rr.full(rr.runs[rr.runs.length - 1].options.emit),
    },
  );
  return { record };
});

interface Request {
  url: URL;
  keepalive: boolean;
  body: ArrayBuffer;
}

let requests: Request[];
let failures: number;

beforeEach(() => {
  rr.runs.length = 0;
  requests = [];
  failures = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit) => {
      if (failures > 0) {
        failures--;
        throw new TypeError('Failed to fetch');
      }
      requests.push({ url: new URL(input), keepalive: !!init.keepalive, body: init.body as ArrayBuffer });
      return { ok: true, status: 204 } as Response;
    }),
  );
});
afterEach(resetPage);

/** The query as an object (the ES2018 lib has no Object.fromEntries). */
function params(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function gunzip(body: ArrayBuffer): Promise<string> {
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(body));
  void writer.close();
  return new Response(stream.readable).text();
}

async function chunks(count: number) {
  await vi.waitFor(() => expect(requests).toHaveLength(count));
  return Promise.all(
    requests.map(async (r) => ({
      path: r.url.pathname,
      params: params(r.url),
      keepalive: r.keepalive,
      events: JSON.parse(await gunzip(r.body)) as Array<{ type: number; timestamp: number; data: Record<string, unknown> }>,
    })),
  );
}

const emit = (e: { type: number; data: unknown; timestamp?: number }) => rr.runs[rr.runs.length - 1].options.emit({ timestamp: Date.now(), ...e });
const move = (x = 1) => emit({ type: 3, data: { source: 1, positions: [{ x, y: 1, id: 1, timeOffset: 0 }] } });

/** Recorders made in a test; stopped after it, so their page listeners go quiet. */
const made: PanelRecorder[] = [];
afterEach(async () => {
  for (const r of made.splice(0)) r.stop();
  // Let what they still send land before the next test looks.
  await new Promise((resolve) => setTimeout(resolve, 30));
});

function recorder(maskingLevel: 'strict' | 'balanced' | 'relaxed' = 'balanced'): PanelRecorder {
  const r = createRecorder({ host: HOST, token: TOKEN, maskingLevel });
  made.push(r);
  return r;
}

describe('chunks', () => {
  it('sends the first chunk after 10 seconds: seq 0, starting with the full snapshot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
    const rec = recorder();
    rec.start('s_one');
    vi.setSystemTime(new Date('2026-11-14T10:00:03Z'));
    move();
    expect(rr.runs).toHaveLength(1);
    expect(rr.runs[0].options).toMatchObject({ maskAllInputs: true, recordCanvas: false, recordCrossOriginIframes: false });
    vi.advanceTimersByTime(9999);
    expect(requests).toHaveLength(0);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();

    const [chunk] = await chunks(1);
    expect(chunk.path).toBe('/r');
    expect(chunk.params).toEqual({
      t: TOKEN,
      s: 's_one',
      q: '0',
      a: String(Date.parse('2026-11-14T10:00:00Z')),
      b: String(Date.parse('2026-11-14T10:00:03Z')),
      f: '1',
    });
    expect(chunk.events.map((e) => e.type)).toEqual([4, 2, 3]);
    expect(chunk.keepalive).toBe(true);
  });

  it('sends at about 64 KB of events, and numbers chunks in order', async () => {
    const rec = recorder();
    rec.start('s_one');
    const big = 'x'.repeat(CHUNK_CHARS / 4);
    for (let i = 0; i < 8; i++) emit({ type: 3, data: { source: 0, texts: [{ id: 1, value: big }] } });
    const sent = await chunks(2);
    expect(sent.map((c) => [c.params.q, c.params.f])).toEqual([
      ['0', '1'],
      ['1', '0'],
    ]);
  });

  it('starts a new chunk with each full snapshot', async () => {
    const rec = recorder();
    rec.start('s_one');
    rec.stop();
    await chunks(1);
    rec.start('s_one');
    move();
    rr.runs[rr.runs.length - 1].options.emit({ type: 4, data: {}, timestamp: Date.now() });
    rr.runs[rr.runs.length - 1].options.emit({ type: 2, data: {}, timestamp: Date.now() });
    rec.stop();
    const sent = await chunks(3);
    expect(sent.map((c) => [c.params.q, c.params.f, c.events.map((e) => e.type).join()])).toEqual([
      ['0', '1', '4,2'],
      ['1', '1', '4,2,3'],
      ['2', '1', '4,2'],
    ]);
  });

  it('counts chunks per session across recorders (pages and tabs)', async () => {
    const first = recorder();
    first.start('s_one');
    first.stop();
    await chunks(1);
    const second = recorder();
    second.start('s_one');
    second.stop();
    const sent = await chunks(2);
    expect(sent.map((c) => c.params.q)).toEqual(['0', '1']);
    expect(JSON.parse(localStorage.getItem(recordingKey(TOKEN))!)).toMatchObject({ s: 's_one', q: 2 });
  });

  it('a new session sends the old one first, then starts at 0 with a full snapshot', async () => {
    const rec = recorder();
    rec.start('s_one');
    move();
    rec.start('s_two');
    rec.stop();
    const sent = await chunks(2);
    expect(sent.map((c) => [c.params.s, c.params.q, c.params.f])).toEqual([
      ['s_one', '0', '1'],
      ['s_two', '0', '1'],
    ]);
    expect(rr.runs.map((r) => r.stopped)).toEqual([true, true]);
  });
});

describe('page lifecycle', () => {
  it('a hidden tab sends what it has and stops; shown again it starts over', async () => {
    const rec = recorder();
    rec.start('s_one');
    move();
    defineOn(document, 'visibilityState', 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rr.runs[0].stopped).toBe(true);
    await chunks(1);

    defineOn(document, 'visibilityState', 'visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(rr.runs).toHaveLength(2);
    rec.stop();
    const sent = await chunks(2);
    expect(sent[1].params).toMatchObject({ q: '1', f: '1' });
  });

  it('page hide sends the buffer', async () => {
    const rec = recorder();
    rec.start('s_one');
    window.dispatchEvent(new Event('pagehide'));
    await chunks(1);
    rec.stop();
  });

  it('stop() sends the buffer, then records nothing until started again', async () => {
    const rec = recorder();
    rec.start('s_one');
    const { emit: stale } = rr.runs[0].options;
    rec.stop();
    stale({ type: 3, data: { source: 1 }, timestamp: Date.now() });
    await chunks(1);
    expect(rr.runs[0].stopped).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
  });

  it('pauses after 30 minutes without input', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const rec = recorder();
    rec.start('s_one');
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    // A clock ticking on the page: mutations, but nobody there.
    emit({ type: 3, data: { source: 0, texts: [] } });
    expect(rr.runs[0].stopped).toBe(true);
    // The core's next event starts it again.
    rec.start('s_one');
    expect(rr.runs).toHaveLength(2);
    vi.useRealTimers();
    rec.stop();
    await chunks(2);
  });
});

describe('transport', () => {
  /** Text gzip can barely shrink. */
  function noise(chars: number): string {
    const bytes = new Uint8Array(chars);
    for (let i = 0; i < chars; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
    let out = '';
    for (let i = 0; i < chars; i += 8192) out += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192), (b) => 35 + (b % 56)));
    return out;
  }

  it('large chunks go without keepalive (its 64 KiB budget)', async () => {
    const rec = recorder();
    rec.start('s_one');
    emit({ type: 3, data: { source: 0, texts: [{ id: 1, value: noise(KEEPALIVE_BYTES * 2) }] } });
    const [chunk] = await chunks(1);
    expect(requests[0].body.byteLength).toBeGreaterThan(KEEPALIVE_BYTES);
    expect(chunk.keepalive).toBe(false);
    rec.stop();
  });

  it('retries a failed keepalive send once without keepalive', async () => {
    failures = 1;
    const rec = recorder();
    rec.start('s_one');
    rec.stop();
    const [chunk] = await chunks(1);
    expect(chunk.keepalive).toBe(false);
  });

  it('halves a chunk that is over 1 MiB gzipped, and drops an event too big on its own', async () => {
    const rec = recorder();
    rec.start('s_one');
    emit({ type: 3, data: { source: 0, value: noise(40 * 1024) } });
    // Pushes the buffer over 64 KB, and the chunk over 1 MiB gzipped.
    emit({ type: 3, data: { source: 0, value: noise(1600 * 1024) } });
    const sent = await chunks(2);
    expect(sent.map((c) => [c.params.q, c.events.map((e) => e.type).join()])).toEqual([
      ['0', '4,2'],
      ['1', '3'],
    ]);
    // Still recording: only a full snapshot that can't be sent ends it.
    move();
    rec.stop();
    await chunks(3);
  }, 30000);

  it('stops recording the page when its full snapshot is too big to send', async () => {
    const rec = recorder();
    rec.start('s_one');
    emit({ type: 4, data: {} });
    emit({ type: 2, data: { node: noise(1600 * 1024) } });
    const sent = await chunks(2);
    expect(sent.map((c) => c.events.map((e) => e.type).join())).toEqual(['4,2', '4']);
    await vi.waitFor(() => expect(rr.runs[0].stopped).toBe(true));
    rec.start('s_one');
    expect(rr.runs).toHaveLength(1);
    // A new session may try again.
    rec.start('s_two');
    expect(rr.runs).toHaveLength(2);
    rec.stop();
    expect((await chunks(3))[2].params).toMatchObject({ s: 's_two', q: '0' });
  }, 30000);
});

describe('snapshot()', () => {
  it('runs rrweb once for a full snapshot and sends it to /snap', async () => {
    const rec = recorder('strict');
    await rec.snapshot('pnh_products', 'mobile');
    expect(rr.runs).toHaveLength(1);
    expect(rr.runs[0].stopped).toBe(true);
    expect(requests).toHaveLength(1);
    const { url, body } = requests[0];
    expect(url.pathname).toBe('/snap');
    expect(params(url)).toEqual({ t: TOKEN, g: 'pnh_products', d: 'mobile' });
    expect(JSON.parse(await gunzip(body))).toMatchObject({ type: 2, data: { node: { id: 1 } } });
  });

  it('while recording, takes one from the running recording', async () => {
    const rec = recorder();
    rec.start('s_one');
    await rec.snapshot('pnh_products', 'desktop');
    expect(rr.runs).toHaveLength(1);
    expect(requests.map((r) => r.url.pathname)).toContain('/snap');
    rec.stop();
  });
});

describe('gzip', () => {
  it('round-trips', async () => {
    expect(await gunzip(await gzip('héllo 😀'))).toBe('héllo 😀');
  });
});
