import { useEffect, useState } from 'react';

/**
 * Returns `true` on narrow (phone) viewports. Used to switch the in-call grid
 * to its Google-Meet-style mobile layout. Resolves to `false` on the server and
 * on first client render (matching the desktop path, so desktop markup is
 * untouched and there's no hydration mismatch), then flips after mount.
 *
 * Breakpoint mirrors Tailwind's `md` (768px): below it = mobile.
 */
export function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [breakpointPx]);

  return isMobile;
}
