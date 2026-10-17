/// <reference lib="webworker" />
/**
 * RNNoise Web Worker — a lighter, battle-tested alternative to the DeepFilterNet3
 * worker. Same message protocol (`WorkerMessage` ↔ `WorkerEvent`) and same
 * 480-sample / 48 kHz frame size, so it drops into the existing
 * worklet ↔ worker pipeline (`DF3NoiseSuppressor` + `df3-worklet-processor`)
 * with no worklet changes.
 *
 * RNNoise (xiph) is a recurrent model that denoises one 480-sample (10 ms @
 * 48 kHz) frame at a time. No ERB filterbank, no multi-frame complex filter,
 * no model URLs to fetch — the wasm binary is inlined in the sync build.
 *
 * Frames normally arrive on a MessagePort straight from the worklet
 * (`connect`) and go back on it, without passing through the main thread;
 * `ready` carries `directPort: true` to say this worker supports that. The
 * main-thread relay (`frame` on `self`) still works for an older main bundle.
 */
import { createRNNWasmModuleSync, type RnnoiseModule } from '@jitsi/rnnoise-wasm';
import { FRAME_SIZE } from './constants';
import type { WorkerEvent, WorkerMessage } from './types';

declare const self: DedicatedWorkerGlobalScope;

// RNNoise's native frame length. Must match FRAME_SIZE (480) so worklet frames
// map 1:1 onto rnnoise frames.
const RNNOISE_FRAME = 480;
// RNNoise consumes/produces int16-scaled floats, not normalised -1..1.
const INT16_SCALE = 32768;

let mod: RnnoiseModule | null = null;
let state = 0;
let pcmPtr = 0;
let heapView: Float32Array | null = null;
let frameCount = 0;
let logRtf = false;
let rtfWindow: number[] = [];

function post(msg: WorkerEvent, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

/** On the direct path the main thread never sees frames, so the RTF summary is sent from here. */
function recordRtf(processingMs: number): void {
  if (!logRtf) return;
  rtfWindow.push(processingMs / 10);
  if (rtfWindow.length < 100) return;
  const mean = rtfWindow.reduce((a, b) => a + b, 0) / rtfWindow.length;
  const max = Math.max(...rtfWindow);
  rtfWindow = [];
  post({ type: 'rtf', mean, max });
}

/** Denoise worklet frames arriving on `port` and send them straight back on it. */
function connectWorklet(port: MessagePort): void {
  port.onmessage = (ev: MessageEvent<{ type: string; pcm: Float32Array }>) => {
    if (ev.data.type !== 'capture-frame') return;
    try {
      const { out, processingMs } = denoise(ev.data.pcm);
      port.postMessage({ type: 'processed-frame', pcm: out }, [out.buffer]);
      recordRtf(processingMs);
    } catch (e) {
      post({ type: 'error', message: String((e as Error)?.message ?? e) });
    }
  };
}

async function init(): Promise<void> {
  if (FRAME_SIZE !== RNNOISE_FRAME) {
    throw new Error(`rnnoise expects ${RNNOISE_FRAME}-sample frames, worklet emits ${FRAME_SIZE}`);
  }
  const m = createRNNWasmModuleSync();
  // The sync build compiles eagerly, but await `ready` if present so we never
  // touch exports before the runtime is bound.
  if (m.ready !== undefined) await m.ready;
  mod = m;
  state = m._rnnoise_create(0);
  pcmPtr = m._malloc(RNNOISE_FRAME * 4);
  heapView = m.HEAPF32.subarray(pcmPtr / 4, pcmPtr / 4 + RNNOISE_FRAME);
  frameCount = 0;
  post({ type: 'ready', directPort: true });
}

/** The main-thread relay: an older main bundle hands frames over on `self`. */
function processFrame(pcm: Float32Array, seq: number): void {
  const { out, processingMs } = denoise(pcm);
  post({ type: 'frame', pcm: out, seq, processingMs }, [out.buffer]);
}

function denoise(pcm: Float32Array): { out: Float32Array; processingMs: number } {
  if (!mod || !heapView) throw new Error('rnnoise worker not initialized');
  const t0 = performance.now();

  // Defensive: if a short frame ever arrives, zero-pad into the heap buffer.
  const n = Math.min(pcm.length, RNNOISE_FRAME);
  for (let i = 0; i < n; i++) heapView[i] = pcm[i] * INT16_SCALE;
  for (let i = n; i < RNNOISE_FRAME; i++) heapView[i] = 0;

  // In-place denoise. Pointer is a byte offset; HEAPF32 may be re-pointed if the
  // heap ever grows, so re-derive the view defensively.
  mod._rnnoise_process_frame(state, pcmPtr, pcmPtr);
  if (mod.HEAPF32.buffer !== heapView.buffer) {
    heapView = mod.HEAPF32.subarray(pcmPtr / 4, pcmPtr / 4 + RNNOISE_FRAME);
  }

  const out = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < n; i++) out[i] = heapView[i] / INT16_SCALE;
  frameCount++;

  return { out, processingMs: performance.now() - t0 };
}

function dispose(): void {
  if (mod) {
    if (state) mod._rnnoise_destroy(state);
    if (pcmPtr) mod._free(pcmPtr);
  }
  mod = null;
  state = 0;
  pcmPtr = 0;
  heapView = null;
  self.close();
}

self.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    logRtf = !!msg.logRtf;
    init().catch((e) => post({ type: 'error', message: String(e?.message ?? e) }));
  } else if (msg.type === 'connect') {
    connectWorklet(msg.port);
  } else if (msg.type === 'frame') {
    try {
      processFrame(msg.pcm, msg.seq);
    } catch (e) {
      post({ type: 'error', message: String((e as Error)?.message ?? e) });
    }
  } else if (msg.type === 'dispose') {
    dispose();
  }
};
