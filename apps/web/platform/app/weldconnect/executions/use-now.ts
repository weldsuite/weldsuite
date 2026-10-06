import { useEffect, useState } from 'react';

/**
 * The current time in ms, re-read every `intervalMs` while `enabled`. Used to
 * tick the elapsed time of a run that is still going; idle otherwise.
 */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);

  return now;
}
