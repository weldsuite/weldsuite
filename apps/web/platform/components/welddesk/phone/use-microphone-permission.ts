import { useCallback, useEffect, useState } from 'react';

/** `unknown` where the browser cannot tell without asking (Firefox, Safari). */
export type MicrophonePermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/**
 * The browser's microphone permission, live, and a way to ask for it. Taking a
 * call needs the microphone; asking when the member switches "take calls" on
 * means the prompt is not the first thing they see while a caller waits.
 */
export function useMicrophonePermission() {
  const [permission, setPermission] = useState<MicrophonePermission>('unknown');

  useEffect(() => {
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const sync = () => {
      if (status && !cancelled) setPermission(status.state);
    };
    if (typeof navigator === 'undefined' || !navigator.permissions) return;
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((result) => {
        if (cancelled) return;
        status = result;
        sync();
        result.addEventListener('change', sync);
      })
      .catch(() => {
        // The browser does not know this permission by name.
      });
    return () => {
      cancelled = true;
      status?.removeEventListener('change', sync);
    };
  }, []);

  /** Prompts when needed; true when the microphone can be used. */
  const request = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setPermission('granted');
      return true;
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') setPermission('denied');
      return false;
    }
  }, []);

  return { permission, request };
}
