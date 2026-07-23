import { SAMPLE_RATE } from './constants';
import type { SuppressorOptions, WorkerEvent } from './types';

/**
 * Wires the AudioWorklet ↔ Web Worker pipeline and exposes a processed
 * MediaStream that can be handed to RealtimeKit's mediaHandler hook.
 *
 * Engine-agnostic: the worklet only buffers 480-sample frames and bridges them
 * to a worker via the main thread; the worker is what actually denoises. Today
 * that worker is RNNoise.
 *
 * A SAB ring buffer is a future optimisation (requires COOP/COEP — see README).
 */
export class NoiseSuppressor {
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;
  private worker: Worker | null = null;
  private readyPromise: Promise<void> | null = null;
  private bypass: boolean;
  private logRtf: boolean;
  private rtfWindow: number[] = [];
  private inputStream: MediaStream | null = null;

  constructor(private readonly options: SuppressorOptions) {
    this.bypass = options.initialBypass ?? false;
    this.logRtf = options.logRtf ?? false;
  }

  async process(inputStream: MediaStream): Promise<MediaStream> {
    // Idempotent. RTK calls getUserMedia again on device switches; we tear
    // down the prior pipeline before standing up a new one so the in-flight
    // worker doesn't receive frames against a discarded session.
    if (this.audioContext) {
      await this.dispose();
    }
    this.inputStream = inputStream;
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (this.audioContext.sampleRate !== SAMPLE_RATE) {
      // eslint-disable-next-line no-console
      console.warn(
        `[noise] AudioContext sampleRate is ${this.audioContext.sampleRate}, expected ${SAMPLE_RATE}. ` +
          'Output quality will degrade — browsers that ignore the sampleRate hint need a resampler.',
      );
    }
    await this.audioContext.audioWorklet.addModule(this.options.workletUrl);

    this.worker = new Worker(this.options.workerUrl, { type: 'module' });
    this.readyPromise = new Promise((resolve, reject) => {
      const onMsg = (ev: MessageEvent<WorkerEvent>) => {
        if (ev.data.type === 'ready') {
          this.worker?.removeEventListener('message', onMsg);
          resolve();
        } else if (ev.data.type === 'error') {
          this.worker?.removeEventListener('message', onMsg);
          reject(new Error(ev.data.message));
        }
      };
      this.worker?.addEventListener('message', onMsg);
    });
    this.worker.postMessage({ type: 'init' });
    await this.readyPromise;

    this.sourceNode = this.audioContext.createMediaStreamSource(inputStream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'df3-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.destinationNode = this.audioContext.createMediaStreamDestination();
    this.workletNode.port.postMessage({ type: 'set-bypass', bypass: this.bypass });

    this.workletNode.port.onmessage = (ev) => {
      const m = ev.data as { type: string; pcm: Float32Array; seq: number };
      if (m.type === 'capture-frame') {
        this.worker?.postMessage({ type: 'frame', pcm: m.pcm, seq: m.seq }, [m.pcm.buffer]);
      }
    };

    this.worker.onmessage = (ev: MessageEvent<WorkerEvent>) => {
      const m = ev.data;
      if (m.type === 'frame') {
        this.workletNode?.port.postMessage({ type: 'processed-frame', pcm: m.pcm }, [m.pcm.buffer]);
        if (this.logRtf) this.recordRtf(m.processingMs);
      } else if (m.type === 'error') {
        // eslint-disable-next-line no-console
        console.error('[noise] worker error:', m.message);
      }
    };

    this.sourceNode.connect(this.workletNode).connect(this.destinationNode);
    return this.destinationNode.stream;
  }

  setBypass(bypass: boolean): void {
    this.bypass = bypass;
    this.workletNode?.port.postMessage({ type: 'set-bypass', bypass });
  }

  private recordRtf(processingMs: number): void {
    const frameMs = 10;
    const rtf = processingMs / frameMs;
    this.rtfWindow.push(rtf);
    if (this.rtfWindow.length >= 100) {
      const mean = this.rtfWindow.reduce((a, b) => a + b, 0) / this.rtfWindow.length;
      const max = Math.max(...this.rtfWindow);
      // eslint-disable-next-line no-console
      console.info(`[noise] RTF over last 1 s — mean ${mean.toFixed(3)}, max ${max.toFixed(3)}`);
      this.rtfWindow = [];
    }
  }

  async dispose(): Promise<void> {
    this.workletNode?.port.close();
    try {
      this.sourceNode?.disconnect();
      this.workletNode?.disconnect();
      this.destinationNode?.disconnect();
    } catch {
      /* node already detached */
    }
    this.worker?.postMessage({ type: 'dispose' });
    this.worker?.terminate();
    this.worker = null;
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
    this.audioContext = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.destinationNode = null;
    // Release the raw microphone. dispose() previously only dropped the
    // reference, leaving the underlying MediaStreamTrack live — so the OS mic
    // indicator stayed on after the user left the meeting.
    this.inputStream?.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    });
    this.inputStream = null;
  }
}
