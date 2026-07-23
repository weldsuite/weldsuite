
/**
 * Notification Sound Utility
 *
 * Plays notification sounds using the Web Audio API.
 * Includes both a generated tone and support for custom audio files.
 */

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  return audioContext;
}

/**
 * Play a simple notification tone using Web Audio API
 * This doesn't require any external audio files
 */
function playNotificationTone(options?: {
  frequency?: number;
  duration?: number;
  volume?: number;
  type?: OscillatorType;
}): void {
  const {
    frequency = 800,
    duration = 150,
    volume = 0.3,
    type = 'sine',
  } = options || {};

  try {
    const ctx = getAudioContext();

    // Resume context if suspended (browsers require user interaction)
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = type;

    // Fade in and out to avoid clicks
    const now = ctx.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(volume, now + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, now + duration / 1000);

    oscillator.start(now);
    oscillator.stop(now + duration / 1000);
  } catch (error) {
    console.warn('Failed to play notification tone:', error);
  }
}

/**
 * Play a gentle two-tone notification chime
 */
function playNotificationChime(): void {
  try {
    const ctx = getAudioContext();

    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    // Gentle, lower-pitched tones for a more natural sound
    // First tone - soft low note
    playTone(ctx, 440, 0, 0.15, 0.15, 'sine');
    // Second tone - gentle higher note
    playTone(ctx, 554, 0.12, 0.2, 0.12, 'sine');
  } catch (error) {
    console.warn('Failed to play notification chime:', error);
  }
}

/**
 * Play a subtle single-note notification (even softer)
 */
function playNotificationPing(): void {
  try {
    const ctx = getAudioContext();

    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    // Single soft ping
    playTone(ctx, 520, 0, 0.25, 0.12, 'sine');
  } catch (error) {
    console.warn('Failed to play notification ping:', error);
  }
}

function playTone(
  ctx: AudioContext,
  frequency: number,
  startDelay: number,
  duration: number,
  volume: number,
  type: OscillatorType = 'sine'
): void {
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.frequency.value = frequency;
  oscillator.type = type;

  const now = ctx.currentTime + startDelay;

  // Softer attack and longer decay for a more natural sound
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(volume, now + 0.02); // Gentle attack
  gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration); // Natural decay

  oscillator.start(now);
  oscillator.stop(now + duration + 0.05);
}

// Cache for audio elements
const audioCache = new Map<string, HTMLAudioElement>();

/**
 * Play a notification sound from an audio file
 * Falls back to generated tone if file fails to load
 */
async function playNotificationSound(
  audioUrl?: string,
  fallbackToTone = true
): Promise<void> {
  const url = audioUrl || '/sounds/notification.mp3';

  try {
    let audio = audioCache.get(url);

    if (!audio) {
      audio = new Audio(url);
      audio.volume = 0.5;
      audioCache.set(url, audio);
    }

    // Reset to beginning if already playing
    audio.currentTime = 0;
    await audio.play();
  } catch (error) {
    console.warn('Failed to play audio file, falling back to tone:', error);
    if (fallbackToTone) {
      playNotificationChime();
    }
  }
}

/**
 * Request notification permission and show a browser notification
 */
export async function showBrowserNotification(
  title: string,
  options?: NotificationOptions & { playSound?: boolean }
): Promise<Notification | null> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return null;
  }

  const { playSound = true, ...notificationOptions } = options || {};

  // Request permission if not granted
  if (Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  if (Notification.permission !== 'granted') {
    return null;
  }

  // Play sound
  if (playSound) {
    playNotificationChime();
  }

  // Show notification
  return new Notification(title, {
    icon: '/favicon.ico',
    ...notificationOptions,
  });
}

/**
 * Play the "message sent" sound effect (short ascending pop)
 */
export function playMessageSentSound(): void {
  playNotificationSound('/sounds/message-sent.wav', true).catch(() => {});
}

/**
 * Play the "message received" sound effect (two-tone chime)
 */
export function playMessageReceivedSound(): void {
  playNotificationSound('/sounds/message-received.wav', true).catch(() => {});
}

// ============================================================================
// Call Sound Effects
// ============================================================================

/** Helper: Clean, minimal enterprise tone — pure sine, gentle envelope, no gimmicks */
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

/** Join call — clean, confident: E5 then G5, spaced apart, calm */
export function playCallJoinSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    cleanTone(ctx, 659, now, 0.2, 0.11);
    cleanTone(ctx, 784, now + 0.18, 0.28, 0.11);
  } catch (e) { console.warn('Call join sound failed:', e); }
}

/** Leave call — calm descending: G5 then E5 */
export function playCallLeaveSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    cleanTone(ctx, 784, now, 0.18, 0.09);
    cleanTone(ctx, 659, now + 0.16, 0.25, 0.08);
  } catch (e) { console.warn('Call leave sound failed:', e); }
}

/** Outgoing ring — classic ringback (440+480Hz double tone). Caller UI loops this while waiting. */
export function playOutgoingRingSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    cleanTone(ctx, 440, now, 0.4, 0.06);
    cleanTone(ctx, 480, now + 0.01, 0.4, 0.06);
  } catch (e) { console.warn('Outgoing ring sound failed:', e); }
}

/** Mute — single quiet low note */
export function playMuteSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    cleanTone(ctx, 440, ctx.currentTime, 0.1, 0.09);
  } catch (e) { console.warn('Mute sound failed:', e); }
}

/** Unmute — single quiet high note */
export function playUnmuteSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    cleanTone(ctx, 587, ctx.currentTime, 0.1, 0.09);
  } catch (e) { console.warn('Unmute sound failed:', e); }
}

/** Camera toggle — minimal tap */
export function playCameraToggleSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    cleanTone(ctx, 523, ctx.currentTime, 0.07, 0.07);
  } catch (e) { console.warn('Camera toggle sound failed:', e); }
}

/** Hand raise — gentle ascending double note */
export function playHandRaiseSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    cleanTone(ctx, 587, now, 0.12, 0.09);
    cleanTone(ctx, 784, now + 0.1, 0.15, 0.09);
  } catch (e) { console.warn('Hand raise sound failed:', e); }
}

/** Hand lower — gentle descending note */
export function playHandLowerSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    cleanTone(ctx, 587, ctx.currentTime, 0.1, 0.07);
  } catch (e) { console.warn('Hand lower sound failed:', e); }
}

/** Screen share — two minimal taps */
export function playScreenShareSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    cleanTone(ctx, 523, now, 0.07, 0.07);
    cleanTone(ctx, 659, now + 0.09, 0.09, 0.07);
  } catch (e) { console.warn('Screen share sound failed:', e); }
}

/**
 * Request notification permission
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'denied';
  }

  if (Notification.permission === 'default') {
    return await Notification.requestPermission();
  }

  return Notification.permission;
}
