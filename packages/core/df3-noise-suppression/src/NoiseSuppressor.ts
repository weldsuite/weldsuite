import { SAMPLE_RATE } from './constants';
import type { SuppressorOptions, WorkerEvent } from './types';

/**
 * One AudioWorklet ↔ Web Worker graph for one input stream.
 *
 * Engine-agnostic: the worklet only buffers 480-sample frames and bridges them
 * to a worker via the main thread; the worker is what actually denoises. Today
 * that worker is RNNoise.
 */
class SuppressionPipeline {
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;
  private worker: Worker | null = null;
  private rtfWindow: number[] = [];
  private inputTracks: MediaStreamTrack[] = [];
  private disposed = false;

  constructor(
    private readonly options: SuppressorOptions,
    private readonly logRtf: boolean,
  ) {}

  async start(inputStream: MediaStream, bypass: boolean): Promise<MediaStream> {
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
    const ready = new Promise<void>((resolve, reject) => {
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
    await ready;

    this.sourceNode = this.audioContext.createMediaStreamSource(inputStream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'df3-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.destinationNode = this.audioContext.createMediaStreamDestination();
    this.setBypass(bypass);

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
    // Only take ownership of the raw mic once the graph is live: if start()
    // throws, the caller falls back to the raw stream, which must stay usable.
    this.inputTracks = inputStream.getAudioTracks();
    return this.destinationNode.stream;
  }

  setBypass(bypass: boolean): void {
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
    if (this.disposed) return;
    this.disposed = true;
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
    // Release the raw microphone, otherwise the OS mic indicator stays on
    // after the user leaves the meeting.
    for (const track of this.inputTracks) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
    this.inputTracks = [];
  }
}

/**
 * Turns raw microphone streams into noise-suppressed ones that can be handed
 * to RealtimeKit (directly, or through `installGetUserMediaPatch`).
 *
 * Every `process()` call gets its own pipeline. RTK acquires the mic more than
 * once per call (it re-acquires when the track's device isn't in its device
 * list, when it thinks the track is silent, on device switches) and keeps
 * using whichever track it settled on, so one pipeline must never tear down
 * another: doing so left RTK holding a track that was still `live` but
 * permanently silent, which no mute/unmute could bring back. A pipeline is
 * released when the track it produced is stopped, and `dispose()` releases
 * whatever is left.
 *
 * A SAB ring buffer is a future optimisation (requires COOP/COEP — see README).
 */
export class NoiseSuppressor {
  private readonly pipelines = new Set<SuppressionPipeline>();
  private bypass: boolean;
  private readonly logRtf: boolean;

  constructor(private readonly options: SuppressorOptions) {
    this.bypass = options.initialBypass ?? false;
    this.logRtf = options.logRtf ?? false;
  }

  /** Processes the stream's audio tracks; video tracks are ignored. */
  async process(inputStream: MediaStream): Promise<MediaStream> {
    const pipeline = new SuppressionPipeline(this.options, this.logRtf);
    this.pipelines.add(pipeline);
    let output: MediaStream;
    try {
      output = await pipeline.start(inputStream, this.bypass);
    } catch (err) {
      this.release(pipeline);
      throw err;
    }
    // RTK stops the tracks it discards, so stopping the processed track is the
    // signal to free its pipeline (and the raw mic behind it).
    const outputTracks = output.getAudioTracks();
    for (const track of outputTracks) {
      const stopTrack = track.stop.bind(track);
      track.stop = () => {
        stopTrack();
        this.release(pipeline);
      };
    }
    // The WebAudio output track never ends on its own. When the raw mic ends
    // (the user revokes microphone access in the browser, the device is
    // unplugged), end the processed track too and fire `ended` like a real
    // mic track would, so RTK drops it and acquires a fresh mic instead of
    // holding a `live` track that stays silent for the rest of the call.
    const onInputEnded = () => {
      for (const track of outputTracks) {
        if (track.readyState === 'ended') continue;
        track.stop();
        track.dispatchEvent(new Event('ended'));
      }
    };
    for (const input of inputStream.getAudioTracks()) {
      input.addEventListener('ended', onInputEnded, { once: true });
    }
    return output;
  }

  setBypass(bypass: boolean): void {
    this.bypass = bypass;
    for (const pipeline of this.pipelines) pipeline.setBypass(bypass);
  }

  private release(pipeline: SuppressionPipeline): void {
    if (!this.pipelines.delete(pipeline)) return;
    pipeline.dispose().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[noise] pipeline dispose error:', err);
    });
  }

  async dispose(): Promise<void> {
    const pipelines = [...this.pipelines];
    this.pipelines.clear();
    await Promise.all(pipelines.map((pipeline) => pipeline.dispose()));
  }
}
