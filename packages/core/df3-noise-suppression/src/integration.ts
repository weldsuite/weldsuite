import { NoiseSuppressor } from './NoiseSuppressor';

export interface CreateRnnoiseSuppressorOptions {
  workerUrl: string;
  workletUrl: string;
  logRtf?: boolean;
}

/**
 * Builds the RNNoise noise-suppression pipeline (worklet + worker bridge).
 * RNNoise's wasm is inlined in the worker bundle, so there are no model URLs
 * to fetch — just point at the worker and worklet bundles.
 */
export function createRnnoiseSuppressor(options: CreateRnnoiseSuppressorOptions): NoiseSuppressor {
  // eslint-disable-next-line no-console
  console.info('[noise] createRnnoiseSuppressor', {
    workerUrl: options.workerUrl,
    workletUrl: options.workletUrl,
  });
  return new NoiseSuppressor({
    workerUrl: options.workerUrl,
    workletUrl: options.workletUrl,
    logRtf: options.logRtf,
  });
}

/**
 * Wraps navigator.mediaDevices.getUserMedia. When audio is requested,
 * routes the raw stream through the suppressor and returns the processed
 * stream (with the original video track if one was requested). Audio-disabled
 * requests are passed through untouched.
 *
 * Returns a restore() that puts the original back. Call restore() on
 * call cleanup BEFORE disposing the suppressor.
 *
 * Known limitation: each intercepted call constructs a fresh pipeline.
 * If RTK or the host app calls getUserMedia multiple times during a
 * single call (device switches, etc.), the previous pipeline leaks until
 * dispose(). Track and fix when we wire up `changeAudioDevice`.
 */
export function installGetUserMediaPatch(suppressor: NoiseSuppressor): () => void {
  const mediaDevices = navigator.mediaDevices;
  const original = mediaDevices.getUserMedia.bind(mediaDevices);
  // eslint-disable-next-line no-console
  console.info('[noise] getUserMedia patch installed');

  const patched = async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
    // eslint-disable-next-line no-console
    console.info('[noise] patched getUserMedia called', { constraints });
    const wantsAudio = !!constraints?.audio;
    if (!wantsAudio) return original(constraints);

    const audioConstraints =
      typeof constraints!.audio === 'object' && constraints!.audio !== null
        ? { ...constraints!.audio }
        : ({} as MediaTrackConstraints);
    audioConstraints.noiseSuppression = false;
    audioConstraints.echoCancellation = audioConstraints.echoCancellation ?? true;
    audioConstraints.autoGainControl = audioConstraints.autoGainControl ?? true;

    const raw = await original({
      audio: audioConstraints,
      video: constraints!.video,
    });

    // Defensive: if init fails (worklet load error, wasm crash, …) we MUST NOT
    // break the mic. Fall back to the raw stream and log a single warning so
    // the user can diagnose, but the call still works without noise suppression.
    let processed: MediaStream;
    try {
      processed = await suppressor.process(raw);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[noise] suppressor failed to init, falling back to raw mic:', err);
      return raw;
    }
    const processedAudio = processed.getAudioTracks()[0];
    if (!processedAudio) {
      // eslint-disable-next-line no-console
      console.warn('[noise] suppressor returned no audio track, falling back to raw mic');
      return raw;
    }

    const out = new MediaStream();
    out.addTrack(processedAudio);
    for (const track of raw.getVideoTracks()) out.addTrack(track);
    return out;
  };

  Object.defineProperty(mediaDevices, 'getUserMedia', {
    configurable: true,
    writable: true,
    value: patched,
  });

  return () => {
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}
