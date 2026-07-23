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
  | { type: 'init' }
  | { type: 'frame'; pcm: Float32Array; seq: number }
  | { type: 'dispose' };

export type WorkerEvent =
  | { type: 'ready' }
  | { type: 'frame'; pcm: Float32Array; seq: number; processingMs: number }
  | { type: 'error'; message: string };
