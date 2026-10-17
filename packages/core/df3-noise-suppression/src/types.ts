export interface SuppressorOptions {
  workerUrl: string;
  workletUrl: string;
  initialBypass?: boolean;
  logRtf?: boolean;
}

export type WorkletMessage =
  | { type: 'frame'; pcm: Float32Array; seq: number }
  | { type: 'set-bypass'; bypass: boolean };

export type WorkerMessage =
  | { type: 'init'; logRtf?: boolean }
  /** The worklet's other end of a MessageChannel: frames then skip the main thread. */
  | { type: 'connect'; port: MessagePort }
  | { type: 'frame'; pcm: Float32Array; seq: number }
  | { type: 'dispose' };

export type WorkerEvent =
  /** `directPort` is set by a worker that accepts `connect`; an older one leaves it out. */
  | { type: 'ready'; directPort?: boolean }
  | { type: 'frame'; pcm: Float32Array; seq: number; processingMs: number }
  /** Real-time factor over the last 100 frames on the direct path (only when `logRtf`). */
  | { type: 'rtf'; mean: number; max: number }
  | { type: 'error'; message: string };
