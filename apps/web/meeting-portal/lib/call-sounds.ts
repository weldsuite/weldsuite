/**
 * Call sound effects for the meeting portal.
 *
 * Self-contained Web Audio tones (no asset files) — mirrors the platform's
 * `apps/web/platform/lib/utils/notification-sound.ts` so a guest in the portal
 * hears the same hand-raise cue a platform participant does.
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  return audioContext;
}

/** Clean, minimal tone — pure sine with a gentle envelope. */
function cleanTone(ctx: AudioContext, freq: number, start: number, dur: number, vol: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(vol, start + 0.015);
  gain.gain.setValueAtTime(vol * 0.9, start + dur * 0.3);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/**
 * Schedule a set of tones. CRITICAL for the portal: unlike the platform (which
 * plays a join sound first, so its AudioContext is already running), the portal
 * plays NO other sound, so the context is created cold on the first hand-raise
 * and starts `suspended`. Scheduling the oscillators at `currentTime` before
 * `resume()` settles produces silence. So we schedule the tones AFTER resume
 * resolves (the click that toggles the hand is the user gesture that unlocks it).
 */
function playTones(tones: Array<{ freq: number; start: number; dur: number; vol: number }>): void {
  try {
    const ctx = getAudioContext();
    const fire = () => {
      const now = ctx.currentTime;
      for (const t of tones) cleanTone(ctx, t.freq, now + t.start, t.dur, t.vol);
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(fire).catch(() => {
        try {
          fire();
        } catch {
          /* ignore */
        }
      });
    } else {
      fire();
    }
  } catch (e) {
    console.warn('Call sound failed:', e);
  }
}

/** Mute — single quiet low note. */
export function playMuteSound(): void {
  playTones([{ freq: 440, start: 0, dur: 0.1, vol: 0.09 }]);
}

/** Unmute — single quiet high note. */
export function playUnmuteSound(): void {
  playTones([{ freq: 587, start: 0, dur: 0.1, vol: 0.09 }]);
}

/** Camera toggle — minimal tap. */
export function playCameraToggleSound(): void {
  playTones([{ freq: 523, start: 0, dur: 0.07, vol: 0.07 }]);
}

/** Hand raise — gentle ascending double note. */
export function playHandRaiseSound(): void {
  playTones([
    { freq: 587, start: 0, dur: 0.12, vol: 0.09 },
    { freq: 784, start: 0.1, dur: 0.15, vol: 0.09 },
  ]);
}

/** Hand lower — gentle descending note. */
export function playHandLowerSound(): void {
  playTones([{ freq: 587, start: 0, dur: 0.1, vol: 0.07 }]);
}
