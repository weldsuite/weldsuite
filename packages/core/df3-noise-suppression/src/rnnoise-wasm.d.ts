/**
 * Minimal typings for `@jitsi/rnnoise-wasm`, which ships no declarations.
 *
 * The package exposes two Emscripten module factories:
 *  - `createRNNWasmModule`     — loads `rnnoise.wasm` separately (async).
 *  - `createRNNWasmModuleSync` — wasm inlined as base64, compiled synchronously.
 *    The README recommends the sync build for AudioWorklet/Worker contexts
 *    where a separate `.wasm` fetch is awkward. We use it so consumers don't
 *    have to serve an extra binary.
 */
declare module '@jitsi/rnnoise-wasm' {
  export interface RnnoiseModule {
    /** Allocate `size` bytes in the wasm heap, returns a byte offset. */
    _malloc(size: number): number;
    /** Free a previously `_malloc`'d byte offset. */
    _free(ptr: number): void;
    /** Create an rnnoise denoise state (pass 0 for the built-in model). */
    _rnnoise_create(model?: number): number;
    /** Destroy a denoise state. */
    _rnnoise_destroy(state: number): void;
    /**
     * Denoise one 480-sample frame in place. `inPtr`/`outPtr` are byte offsets
     * into HEAPF32; samples are int16-scaled floats (-32768..32767). May be the
     * same pointer for in-place processing. Returns the VAD probability (0..1).
     */
    _rnnoise_process_frame(state: number, outPtr: number, inPtr: number): number;
    /** Float32 view over the wasm heap. */
    HEAPF32: Float32Array;
    /** Resolves once the runtime is initialised (sync build resolves eagerly). */
    ready?: Promise<RnnoiseModule>;
  }

  export function createRNNWasmModule(overrides?: Record<string, unknown>): Promise<RnnoiseModule>;
  export function createRNNWasmModuleSync(overrides?: Record<string, unknown>): RnnoiseModule;
}
