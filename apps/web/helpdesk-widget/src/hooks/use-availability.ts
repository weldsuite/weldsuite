import { useEffect, useState } from 'react';
import type { WidgetConfigResponse } from '@/lib/api/types';

/** setTimeout's ceiling (~24.8 days); anything later waits for the next page load. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function reachedAt(iso: string | null): boolean {
  return iso !== null && Date.now() >= new Date(iso).getTime();
}

/**
 * Whether the team is away (outside office hours) right now. The API answers
 * when the widget loads; if the visitor keeps it open past `nextOpenAt`, the
 * widget flips back to "in" by itself.
 */
export function useAvailability(config: WidgetConfigResponse) {
  const closed = config.availability ? !config.availability.isOpen : false;
  const nextOpenAt = config.availability?.nextOpenAt ?? null;
  const [reopened, setReopened] = useState(() => reachedAt(nextOpenAt));

  useEffect(() => {
    setReopened(reachedAt(nextOpenAt));
    if (!closed || !nextOpenAt) return;
    const wait = new Date(nextOpenAt).getTime() - Date.now();
    if (wait <= 0 || wait > MAX_TIMEOUT_MS) return;
    const timer = setTimeout(() => setReopened(true), wait);
    return () => clearTimeout(timer);
  }, [closed, nextOpenAt]);

  return { away: closed && !reopened, nextOpenAt };
}
