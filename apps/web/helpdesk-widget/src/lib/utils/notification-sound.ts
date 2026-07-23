/**
 * Notification Sound Utility for Helpdesk Widget
 *
 * Plays message sent/received sounds using HTMLAudioElement.
 * Falls back to Web Audio API synthesized tones if files fail to load.
 */

const audioCache = new Map<string, HTMLAudioElement>();

async function playSound(url: string): Promise<void> {
  try {
    let audio = audioCache.get(url);
    if (!audio) {
      audio = new Audio(url);
      audio.volume = 0.5;
      audioCache.set(url, audio);
    }
    audio.currentTime = 0;
    await audio.play();
  } catch {
    // Fall back to synthesized tone
    playFallbackTone(url.includes('sent') ? 'sent' : 'received');
  }
}

function playFallbackTone(type: 'sent' | 'received'): void {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;

    if (type === 'sent') {
      // Happy ascending "bloop" pop
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(500, now);
      osc.frequency.linearRampToValueAtTime(900, now + 0.18);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.35, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
      osc.start(now);
      osc.stop(now + 0.2);
    } else {
      // Happy two-tone ascending "bloop bloop"
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.frequency.setValueAtTime(520, now);
      osc1.frequency.linearRampToValueAtTime(680, now + 0.13);
      gain1.gain.setValueAtTime(0, now);
      gain1.gain.linearRampToValueAtTime(0.3, now + 0.005);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      osc1.start(now);
      osc1.stop(now + 0.15);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.setValueAtTime(660, now + 0.11);
      osc2.frequency.linearRampToValueAtTime(880, now + 0.28);
      gain2.gain.setValueAtTime(0, now + 0.11);
      gain2.gain.linearRampToValueAtTime(0.3, now + 0.115);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc2.start(now + 0.11);
      osc2.stop(now + 0.3);
    }
  } catch {
    // Silently fail - sound is not critical
  }
}

/**
 * Play the "message sent" sound effect
 */
export function playMessageSentSound(): void {
  playSound('/sounds/message-sent.wav').catch(() => {});
}

/**
 * Play the "message received" sound effect
 */
export function playMessageReceivedSound(): void {
  playSound('/sounds/message-received.wav').catch(() => {});
}
