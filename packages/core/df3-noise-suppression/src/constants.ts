/**
 * Audio pipeline constants shared by the worklet, the worker, and the
 * NoiseSuppressor host. RNNoise operates on 480-sample (10 ms @ 48 kHz)
 * mono frames, which is exactly what the worklet emits — so frames map 1:1
 * with no resampling.
 */
export const SAMPLE_RATE = 48000;
export const FRAME_SIZE = 480;
