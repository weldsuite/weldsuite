# @weldsuite/df3-noise-suppression

Real-time **RNNoise** ([xiph](https://people.xiph.org/~jm/demo/rnnoise/))
noise suppression for the WeldMeet WEB clients (platform + meeting-portal).
Browser-side WASM via [`@jitsi/rnnoise-wasm`](https://github.com/jitsi/rnnoise-wasm).
No backend, no Cloudflare Worker inference, no model download.

> **Note on the name.** This package was originally a DeepFilterNet3 (DF3)
> implementation; that engine was removed in favour of RNNoise (simpler,
> battle-tested, no model fetch, no DSP to validate). The package, worklet
> file (`df3-worklet-processor.js`) and `df3-install-*` bin names are kept
> as-is to avoid churn, renaming to `@weldsuite/noise-suppression` is an
> optional follow-up.

## Architecture

```
MediaStream (mic)
  └─> AudioContext (sampleRate: 48000)
      └─> MediaStreamSource
          └─> AudioWorkletNode (df3-processor)
              ├─ buffers 128-sample blocks into 480-sample frames
              ├─ postMessage frame → main thread → Web Worker
              ├─ receives processed frame ← Web Worker ← main thread
              └─ writes processed frame to output (jitter-buffered)
          └─> MediaStreamDestination
              └─> processed MediaStreamTrack → RealtimeKit

Web Worker (rnnoise-worker):
  scale ×32768 → rnnoise_process_frame (480-sample, in place) → scale ÷32768
```

RNNoise's native frame is **480 samples @ 48 kHz**, exactly what the worklet
emits, so frames map 1:1 with **no resampling** and **no lookahead latency**.
The wasm is inlined (base64) via `createRNNWasmModuleSync`, so there is no
separate `.wasm` to serve and **no COOP/COEP requirement**.

**Why a worker (not the worklet directly)?** Keeps the wasm module + heap off
the audio render thread; the worklet only buffers and bridges frames. The
worklet is engine-agnostic.

## Frame size

| Constant      | Value | Source                       |
|---------------|------:|------------------------------|
| `SAMPLE_RATE` | 48000 | RNNoise / WebAudio default   |
| `FRAME_SIZE`  |   480 | RNNoise native frame (10 ms) |

## Usage

```ts
import { createRnnoiseSuppressor, installGetUserMediaPatch } from '@weldsuite/df3-noise-suppression';

const suppressor = createRnnoiseSuppressor({
  workerUrl:  '/rnnoise-worker.js',          // Next: copied to public/ via postinstall
  workletUrl: '/df3-worklet-processor.js',   // copied to public/ via postinstall
  logRtf: process.env.NODE_ENV !== 'production',
});

// Easiest integration: patch getUserMedia so RTK's internal acquisition flows
// through the suppressor. Returns a restore(), call it before dispose().
const restore = installGetUserMediaPatch(suppressor);

// …RealtimeKit.init({ mediaConfiguration: { audio: { noiseSupression: false } } })…

// on call end:
restore();
await suppressor.dispose();
```

For manual stream wiring, `suppressor.process(rawStream)` returns the processed
`MediaStream`, and `suppressor.setBypass(true|false)` toggles passthrough.

## Consumer plumbing

The worker and worklet must be served from the host app's static origin, both `new Worker(url, { type: 'module' })` and `audioWorklet.addModule(url)`
require same-origin URLs.

### Vite (apps/web/platform)

Import the worker via Vite's `?worker&url` suffix (Vite bundles it, wasm
inlined, into a hashed public asset):

```ts
import rnnoiseWorkerUrl from '@weldsuite/df3-noise-suppression/rnnoise-worker?worker&url';
```

The worklet is copied to `public/df3-worklet-processor.js` by the
`df3-install-worklet` postinstall step.

### Next.js (apps/web/meeting-portal)

Both bundles are copied to `public/` via postinstall:

```
df3-install-worklet public/df3-worklet-processor.js
df3-install-rnnoise-worker public/rnnoise-worker.js
```

`df3-install-rnnoise-worker` esbuild-bundles `src/rnnoise-worker.ts` (wasm
inlined) into a single ESM file.

## Performance

RTF (run-time factor = `processingMs / 10ms`) is logged in dev when
`logRtf: true`. RNNoise is very light, RTF is well under 1.0 on all targets,
so no per-device pre-emption is needed.

## Known limitations

- WEB clients only (platform + meeting-portal). Mobile is a follow-up.
- AudioContext fixed at 48 kHz; if a browser ignores the hint we only warn
  (a resampler is a TODO).
- No mute-on-distortion watchdog, if the worker hangs, flip bypass.
