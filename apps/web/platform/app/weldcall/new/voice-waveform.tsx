import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

const BAR_COUNT = 40;
const CENTER = (BAR_COUNT - 1) / 2;
/** Resting height of a bar, as a fraction of the full height. */
const MIN_LEVEL = 0.06;
const BAR_KEYS = Array.from({ length: BAR_COUNT }, (_, i) => `bar-${i}`);
/** How far a bar sits from the middle, 0 (centre) to 1 (edge). */
const barSpread = (i: number) => Math.abs(i - CENTER) / CENTER;
// Speech runs from ~190 Hz (bin 1) to ~4 kHz (bin 21); spaced logarithmically so a voice moves every bar, not just the middle few
const SPEECH_TOP_BIN = 21;
const BAR_BINS = BAR_KEYS.map((_, i) => SPEECH_TOP_BIN ** barSpread(i));
// Speech gets quieter towards the high end; lift the outer bars so they keep up
const BAR_GAIN = BAR_KEYS.map((_, i) => 1 + 0.6 * barSpread(i));

/**
 * - `live`: follows the audio of `streams` as it plays; silence (or no stream) rests flat
 * - `flat`: resting bars, while ringing, on hold or after the call
 */
export type WaveformMode = 'live' | 'flat';

interface StreamSampler {
  read: () => number[];
  close: () => void;
}

/** Reads voice-band loudness from each stream, every frame; the louder side wins per bar. */
function createStreamSampler(streams: MediaStream[]): StreamSampler | null {
  const withAudio = streams.filter((s) => s.getAudioTracks().length > 0);
  if (withAudio.length === 0 || typeof AudioContext === 'undefined') return null;

  const audioContext = new AudioContext();
  void audioContext.resume();
  const analysers = withAudio.map((stream) => {
    const analyser = audioContext.createAnalyser();
    // 128 bins of ~190 Hz at 48 kHz: bins 1–20 cover the speech band
    analyser.fftSize = 256;
    // Light smoothing keeps the bars on the syllable without flicker
    analyser.smoothingTimeConstant = 0.45;
    // Room noise sits below -80 dB and speech peaks around -25 dB
    analyser.minDecibels = -80;
    analyser.maxDecibels = -25;
    // Not connected to the destination: the call's own audio element plays it
    audioContext.createMediaStreamSource(stream).connect(analyser);
    return analyser;
  });
  const bins = new Uint8Array(analysers[0].frequencyBinCount);

  return {
    read() {
      const levels = new Array<number>(BAR_COUNT).fill(0);
      for (const analyser of analysers) {
        analyser.getByteFrequencyData(bins);
        for (let i = 0; i < BAR_COUNT; i++) {
          // Low frequencies in the middle, higher ones towards the edges, blended between bins
          const lo = Math.floor(BAR_BINS[i]);
          const frac = BAR_BINS[i] - lo;
          const value = (bins[lo] * (1 - frac) + bins[lo + 1] * frac) / 255;
          levels[i] = Math.max(levels[i], Math.min(1, value * BAR_GAIN[i]));
        }
      }
      return levels.map((v) => MIN_LEVEL + (1 - MIN_LEVEL) * v);
    },
    close() {
      void audioContext.close();
    },
  };
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

interface VoiceWaveformProps {
  mode: WaveformMode;
  /** Memoize: a new array restarts the audio analysis. */
  streams: MediaStream[];
  className?: string;
}

export function VoiceWaveform({ mode, streams, className }: Readonly<VoiceWaveformProps>) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const paint = (levels: number[]) => {
      barsRef.current.forEach((bar, i) => {
        if (bar) bar.style.transform = `scaleY(${levels[i]})`;
      });
    };

    const sampler = mode === 'live' && !prefersReducedMotion() ? createStreamSampler(streams) : null;
    if (!sampler) {
      paint(new Array<number>(BAR_COUNT).fill(MIN_LEVEL));
      return;
    }

    let frame = requestAnimationFrame(function tick() {
      paint(sampler.read());
      frame = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frame);
      sampler.close();
    };
  }, [mode, streams]);

  return (
    <div
      aria-hidden="true"
      data-testid="weldcall-waveform"
      data-mode={mode}
      className={cn('flex h-32 items-center justify-center gap-1', className)}
    >
      {BAR_KEYS.map((key, i) => (
        <span
          key={key}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className="h-full w-1 rounded-full bg-foreground origin-center"
          style={{ transform: `scaleY(${MIN_LEVEL})` }}
        />
      ))}
    </div>
  );
}
