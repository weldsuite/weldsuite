import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react';

const STORAGE_KEY = 'weldmeet-speaker-output';

/** The browser's own "system default" entry in the output device list (Chrome). */
const DEFAULT_DEVICE_ID = 'default';

interface SpeakerOutputState {
  /** Audio output devices the browser exposes. Empty until permission is granted. */
  devices: MediaDeviceInfo[];
  /**
   * The output remote audio is routed to; `''` is the system default. Falls
   * back to `''` while the preferred device is unplugged, so a headset that
   * drops mid-call moves the sound to the default output instead of silencing it.
   */
  deviceId: string;
}

const EMPTY_STATE: SpeakerOutputState = { devices: [], deviceId: '' };

// ── Store ─────────────────────────────────────────────────────────────────
// One selection for the whole tab: remote audio is played by many <audio>
// elements (one per tile, the hidden sinks, the PiP widgets) owned by different
// components and host apps, and they all have to follow the same choice.

let preferredId: string | null = null;
let devices: MediaDeviceInfo[] = [];
let state: SpeakerOutputState = EMPTY_STATE;
const listeners = new Set<() => void>();

function getPreferredId(): string {
  if (preferredId === null) {
    try {
      preferredId = localStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      preferredId = '';
    }
  }
  return preferredId;
}

function emit() {
  const preferred = getPreferredId();
  const deviceId = devices.some((d) => d.deviceId === preferred) ? preferred : '';
  state = { devices, deviceId };
  listeners.forEach((listener) => listener());
}

/** Whether this browser can route audio to a chosen output (not Safari / most mobile). */
export function isSpeakerSelectionSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** Re-reads the audio output devices. Called on `devicechange`; safe to call any time. */
export async function refreshSpeakerDevices(): Promise<void> {
  if (!isSpeakerSelectionSupported()) return;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    // Before the site has device permission the entries come back without ids.
    devices = all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '');
  } catch {
    devices = [];
  }
  emit();
}

/** Picks the output for remote audio. `''` (or the browser's default entry) follows the system. */
export function setSpeakerDeviceId(deviceId: string): void {
  preferredId = deviceId === DEFAULT_DEVICE_ID ? '' : deviceId;
  try {
    localStorage.setItem(STORAGE_KEY, preferredId);
  } catch { /* ignore */ }
  emit();
}

function onDeviceChange() {
  void refreshSpeakerDevices();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
    } catch { /* not available in this environment */ }
    void refreshSpeakerDevices();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      try {
        navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      } catch { /* not available in this environment */ }
    }
  };
}

function getSnapshot(): SpeakerOutputState {
  return state;
}

function getServerSnapshot(): SpeakerOutputState {
  return EMPTY_STATE;
}

// ── Hooks ─────────────────────────────────────────────────────────────────

/** Output devices + the active one, for a speaker picker. */
export function useSpeakerDevices() {
  const { devices: list, deviceId } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // With nothing chosen the system default is in use: highlight the browser's
  // own "Default" entry when it lists one.
  const activeDeviceId =
    deviceId || (list.some((d) => d.deviceId === DEFAULT_DEVICE_ID) ? DEFAULT_DEVICE_ID : '');
  return {
    devices: list,
    activeDeviceId,
    setDeviceId: useCallback((id: string) => setSpeakerDeviceId(id), []),
  };
}

/**
 * Routes an `<audio>` element that plays remote sound to the chosen speaker.
 * Call it next to every such element, with the element's ref.
 */
export function useSpeakerOutput(ref: RefObject<HTMLMediaElement | null>): void {
  const { deviceId } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // No dependency list on purpose: several of these elements are rendered
  // conditionally, so the ref can go from null to an element on a render that
  // changes nothing this hook could depend on. The check below is cheap.
  useEffect(() => {
    const el = ref.current;
    if (!el || !isSpeakerSelectionSupported() || el.sinkId === deviceId) return;
    el.setSinkId(deviceId).catch(() => { /* device gone or not allowed: stays on the previous output */ });
  });
}
