/*
 * AudioWorkletProcessor for the noise suppressor (engine-agnostic).
 *
 * Buffers input into 480-sample frames (10 ms @ 48 kHz), hands them to the
 * denoising Web Worker and emits the processed frames back onto the output.
 * Denoising runs in the worker, not here — the worklet render thread stays
 * free of the wasm module and its heap.
 *
 * DIRECT PORT: the main thread connects this worklet to the worker with a
 * MessageChannel (`connect`), so frames go worklet ↔ worker without touching
 * the main thread. Relaying every frame through the main thread made the
 * audio wait whenever the page was busy (a long render, GC, a background
 * tab), which is heard as the voice lagging. Without a `connect` (an older
 * main bundle, or a worker that cannot take a port) frames still go through
 * `this.port`, as before.
 *
 * JITTER BUFFER: The worker returns frames asynchronously. Without a pre-buffer
 * the queue runs dry every 10 ms (creating 100 Hz "bubbling"). We hold output
 * until JITTER_FRAMES * 480 samples are queued, giving the worker headroom.
 *
 * LATENCY CAP: output plays at exactly the rate input arrives, so anything
 * that piles up in the queue (frames delivered in a burst after a stall) would
 * stay as extra delay for the rest of the call. Beyond MAX_QUEUED_FRAMES the
 * oldest frames are dropped: a 10 ms skip once, instead of a voice that lags
 * further behind with every hiccup.
 */

const FRAME_SIZE = 480;
const JITTER_FRAMES = 1; // pre-buffer this many frames before starting output
const MAX_QUEUED_FRAMES = 3; // past this (30 ms), drop the oldest frames

class DF3Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._inBuf = new Float32Array(FRAME_SIZE);
    this._inIdx = 0;
    this._outQueue = [];
    this._outPartial = null;
    this._outPartialIdx = 0;
    this._bypass = false;
    this._seq = 0;
    // Jitter buffer: track total queued samples and whether playback has started.
    this._queuedSamples = 0;
    this._started = false;
    /** The worker's end of the direct channel, once connected. */
    this._workerPort = null;
    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'processed-frame') {
        this._enqueue(m.pcm);
      } else if (m.type === 'set-bypass') {
        this._bypass = !!m.bypass;
      } else if (m.type === 'connect' && m.port) {
        this._workerPort = m.port;
        this._workerPort.onmessage = (portEv) => {
          if (portEv.data.type === 'processed-frame') this._enqueue(portEv.data.pcm);
        };
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input?.[0] || !output?.[0]) return true;

    const inCh = input[0];
    const outCh = output[0];

    if (this._bypass) {
      outCh.set(inCh);
      return true;
    }

    this._captureInput(inCh);

    // Jitter buffer: wait until we have at least JITTER_FRAMES * FRAME_SIZE
    // samples queued before starting playback. After that, play continuously.
    if (!this._started) {
      if (this._queuedSamples < JITTER_FRAMES * FRAME_SIZE) {
        outCh.fill(0);
        return true;
      }
      this._started = true;
    }

    this._drainOutput(outCh);
    return true;
  }

  _enqueue(pcm) {
    this._outQueue.push(pcm);
    this._queuedSamples += pcm.length;
    // Latency cap: past MAX_QUEUED_FRAMES, trim back to the jitter target plus
    // one frame of headroom. Trimming only down to the cap would leave the
    // extra frames as permanent delay, since output drains at the input rate.
    if (this._outQueue.length > MAX_QUEUED_FRAMES) {
      while (this._outQueue.length > JITTER_FRAMES + 1) {
        this._queuedSamples -= this._outQueue.shift().length;
      }
    }
  }

  // Accumulate input into 480-sample frames and send to worker.
  _captureInput(inCh) {
    for (let i = 0; i < inCh.length; i++) {
      this._inBuf[this._inIdx++] = inCh[i];
      if (this._inIdx === FRAME_SIZE) {
        const frame = new Float32Array(this._inBuf);
        const target = this._workerPort ?? this.port;
        target.postMessage({ type: 'capture-frame', pcm: frame, seq: this._seq++ }, [frame.buffer]);
        this._inIdx = 0;
      }
    }
  }

  // Drain the output queue into the audio engine block, zero-filling on underrun.
  _drainOutput(outCh) {
    let written = 0;
    while (written < outCh.length) {
      if (!this._outPartial && !this._nextPartial()) {
        outCh.fill(0, written);
        return;
      }
      const take = Math.min(outCh.length - written, this._outPartial.length - this._outPartialIdx);
      for (let i = 0; i < take; i++) outCh[written + i] = this._outPartial[this._outPartialIdx + i];
      this._queuedSamples -= take;
      written += take;
      this._outPartialIdx += take;
      if (this._outPartialIdx === this._outPartial.length) this._outPartial = null;
    }
  }

  // Pull the next queued frame; returns false when the queue is empty.
  _nextPartial() {
    if (this._outQueue.length === 0) return false;
    this._outPartial = this._outQueue.shift();
    this._outPartialIdx = 0;
    return true;
  }
}

registerProcessor('df3-processor', DF3Processor);
