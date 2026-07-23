# DF3 Noise Suppression, Third-Party Notices

> The package name is legacy. The DeepFilterNet (DF3) engine and its
> `onnxruntime-web` runtime were removed on 2026-05-28; **RNNoise is now the
> sole engine.** The name is kept deliberately to avoid a disruptive rename.

This package bundles the following:

- **RNNoise**, Jean-Marc Valin / Xiph.Org Foundation / Mozilla. Source:
  https://github.com/xiph/rnnoise. **BSD-3-Clause.** The recurrent-neural-network
  noise-suppression model and C code, compiled to WebAssembly.
- **@jitsi/rnnoise-wasm** 0.2.x, 8x8, Inc. / Jitsi. Source:
  https://github.com/jitsi/rnnoise-wasm. **Apache-2.0.** The WebAssembly build of
  RNNoise; the wasm is inlined (base64) into the generated `rnnoise-worker.js`,
  so there is no separate `.wasm` file to serve.

The `df3-worklet-processor.js` AudioWorklet is first-party, engine-agnostic
WeldSuite code (no third-party dependency).

See the root `THIRD_PARTY_NOTICES.md` for the canonical list.
