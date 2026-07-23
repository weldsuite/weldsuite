/*
 * AudioWorkletProcessor for the noise suppressor (engine-agnostic).
 *
 * Buffers input into 480-sample frames (10 ms @ 48 kHz), forwards them to
 * the main thread via the worklet port, and emits processed frames back
 * onto the output. Denoising runs in a Web Worker, not here — the worklet
 * render thread stays free of the wasm module and its heap.
 *
 * JITTER BUFFER: The worker returns frames asynchronously. Without a pre-buffer
 * the queue runs dry every 10 ms (creating 100 Hz "bubbling"). We hold output
 * until JITTER_FRAMES * 480 samples are queued, giving the worker headroom.
 * One frame (10 ms) of extra latency is imperceptible in a call.
 */

const FRAME_SIZE = 480;
const BLOCK_SIZE = 128;
const JITTER_FRAMES = 1; // pre-buffer this many frames before starting output

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
    this.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'processed-frame') {
        this._outQueue.push(m.pcm);
        this._queuedSamples += m.pcm.length;
      } else if (m.type === 'set-bypass') {
        this._bypass = !!m.bypass;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inCh = input[0];
    const outCh = output[0];

    if (this._bypass) {
      outCh.set(inCh);
      return true;
    }

    // Accumulate input into 480-sample frames and send to worker.
    for (let i = 0; i < inCh.length; i++) {
      this._inBuf[this._inIdx++] = inCh[i];
      if (this._inIdx === FRAME_SIZE) {
        const frame = new Float32Array(this._inBuf);
        this.port.postMessage({ type: 'capture-frame', pcm: frame, seq: this._seq++ }, [frame.buffer]);
        this._inIdx = 0;
      }
    }

    // Jitter buffer: wait until we have at least JITTER_FRAMES * FRAME_SIZE
    // samples queued before starting playback. After that, play continuously.
    if (!this._started) {
      if (this._queuedSamples < JITTER_FRAMES * FRAME_SIZE) {
        for (let i = 0; i < outCh.length; i++) outCh[i] = 0;
        return true;
      }
      this._started = true;
    }

    // Drain the output queue into the audio engine block.
    let written = 0;
    while (written < outCh.length) {
      if (!this._outPartial) {
        if (this._outQueue.length === 0) {
          for (let i = written; i < outCh.length; i++) outCh[i] = 0;
          break;
        }
        this._outPartial = this._outQueue.shift();
        this._outPartialIdx = 0;
      }
      const take = Math.min(outCh.length - written, this._outPartial.length - this._outPartialIdx);
      for (let i = 0; i < take; i++) outCh[written + i] = this._outPartial[this._outPartialIdx + i];
      this._queuedSamples -= take;
      written += take;
      this._outPartialIdx += take;
      if (this._outPartialIdx === this._outPartial.length) this._outPartial = null;
    }

    return true;
  }
}

registerProcessor('df3-processor', DF3Processor);
