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

function post(msg: WorkerEvent, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

async function init(): Promise<void> {
  if (FRAME_SIZE !== RNNOISE_FRAME) {
    throw new Error(`rnnoise expects ${RNNOISE_FRAME}-sample frames, worklet emits ${FRAME_SIZE}`);
  }
  const m = createRNNWasmModuleSync();
  // The sync build compiles eagerly, but await `ready` if present so we never
  // touch exports before the runtime is bound.
  if (m.ready) await m.ready;
  mod = m;
  state = m._rnnoise_create(0);
  pcmPtr = m._malloc(RNNOISE_FRAME * 4);
  heapView = m.HEAPF32.subarray(pcmPtr / 4, pcmPtr / 4 + RNNOISE_FRAME);
  frameCount = 0;
  post({ type: 'ready' });
}

function processFrame(pcm: Float32Array, seq: number): void {
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

  post({ type: 'frame', pcm: out, seq, processingMs: performance.now() - t0 }, [out.buffer]);
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
    init().catch((e) => post({ type: 'error', message: String(e?.message ?? e) }));
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
