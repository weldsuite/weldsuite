import { useEffect, useRef } from 'react';

import { enableMicrophone, type EnableMicrophoneResult, type MicrophoneSelf } from '../lib/microphone';

export interface UseMicrophoneRecoveryOptions {
  /** Whether the user wants their mic on (they had it on when access was lost). */
  isMicWanted: () => boolean;
  /** Microphone access was revoked: the mic is off now, whatever RTK reports. */
  onLost?: () => void;
  /** Access came back and the mic was turned back on (or failed to). */
  onRestored?: (result: EnableMicrophoneResult) => void;
}

/**
 * Brings the mic back when the user allows microphone access again mid-call.
 *
 * Revoking access in the browser ends the mic track; allowing it again does
 * not give RTK a new one, so the mic stayed off until a rejoin (TASK-713).
 * This watches the browser permission and, when it flips back to granted
 * while the user still wants their mic on, re-acquires it.
 */
export function useMicrophoneRecovery(
  self: MicrophoneSelf | null | undefined,
  options: UseMicrophoneRecoveryOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!self || typeof navigator === 'undefined') return;
    const query = navigator.permissions?.query?.bind(navigator.permissions);
    if (!query) return;
    let cancelled = false;
    let permission: PermissionStatus | null = null;
    let lastState: PermissionState | null = null;

    const onChange = () => {
      if (!permission) return;
      const state = permission.state;
      const previous = lastState;
      lastState = state;
      if (state === 'denied') {
        optionsRef.current.onLost?.();
        return;
      }
      if (state !== 'granted' || previous === 'granted') return;
      if (!optionsRef.current.isMicWanted() || self.audioEnabled) return;
      void enableMicrophone(self).then((result) => {
        if (!cancelled) optionsRef.current.onRestored?.(result);
      });
    };

    query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (cancelled) return;
        permission = status;
        lastState = status.state;
        status.addEventListener('change', onChange);
      })
      .catch(() => { /* microphone permission not queryable in this browser */ });

    return () => {
      cancelled = true;
      permission?.removeEventListener('change', onChange);
    };
  }, [self]);
}
