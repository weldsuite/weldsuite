/**
 * The noise-suppression worklet the platform serves (public/df3-worklet-processor.js,
 * copied from @weldsuite/df3-noise-suppression): frames go to the worker over a
 * direct port when one is connected (never through the main thread), and a
 * burst of frames after a stall cannot leave the voice permanently delayed.
 * Tested here because the package itself has no test runner.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

const fakePort = (): FakePort => ({ postMessage: vi.fn(), onmessage: null });

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

let Processor: new () => Processor;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).AudioWorkletProcessor = class {
    port = fakePort();
  };
  (globalThis as Record<string, unknown>).registerProcessor = (_name: string, ctor: new () => Processor) => {
    Processor = ctor;
  };
  // A worklet is a script that registers itself, not a module with exports,
  // so it is imported for its side effect through a non-literal specifier.
  const worklet = '@weldsuite/df3-noise-suppression/worklet';
  await import(/* @vite-ignore */ worklet);
});

const FRAME = 480;
const BLOCK = 128;

/** A processed frame whose every sample is `value`, so output tells frames apart. */
const frame = (value: number) => new Float32Array(FRAME).fill(value);

/** Run one 128-sample render quantum and return what it output. */
function render(p: Processor): Float32Array {
  const out = new Float32Array(BLOCK);
  p.process([[new Float32Array(BLOCK)]], [[out]]);
  return out;
}

/** Deliver a processed frame the way the worker does. */
function deliver(port: FakePort, value: number) {
  port.onmessage?.({ data: { type: 'processed-frame', pcm: frame(value) } });
}

describe('df3 worklet · where frames go', () => {
  it('sends captured frames over the main-thread port when no worker port is connected', () => {
    const p = new Processor();
    for (let i = 0; i < 4; i++) render(p); // 512 samples: one full frame captured
    expect(p.port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'capture-frame' }),
      expect.any(Array),
    );
  });

  it('sends them straight to the worker once connected, and plays what comes back on that port', () => {
    const p = new Processor();
    const workerPort = fakePort();
    p.port.onmessage?.({ data: { type: 'connect', port: workerPort } });

    for (let i = 0; i < 4; i++) render(p);
    expect(workerPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'capture-frame' }),
      expect.any(Array),
    );
    expect(p.port.postMessage).not.toHaveBeenCalled();

    deliver(workerPort, 0.5);
    expect(render(p)[0]).toBe(0.5);
  });
});

describe('df3 worklet · latency', () => {
  it('plays every frame in order while they arrive on time', () => {
    const p = new Processor();
    deliver(p.port, 1);
    deliver(p.port, 2);
    const played: number[] = [];
    for (let i = 0; i < 8; i++) played.push(render(p)[0]);
    // First sample of each 128-sample block: frame 1 covers samples 0–479,
    // frame 2 covers 480–959. Both frames, in order, nothing dropped.
    expect(played).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it('drops the oldest frames of a burst instead of keeping them as delay', () => {
    const p = new Processor();
    deliver(p.port, 1);
    render(p); // playback started on frame 1

    // A stall: six frames arrive at once (60 ms of audio).
    for (let v = 2; v <= 7; v++) deliver(p.port, v);

    // The rest of frame 1 plays, then only the newest two frames are left.
    const values = new Set<number>();
    for (let i = 0; i < 12; i++) values.add(render(p)[0]);
    expect(values.has(6)).toBe(true);
    expect(values.has(7)).toBe(true);
    for (const stale of [2, 3, 4, 5]) expect(values.has(stale)).toBe(false);
  });
});
