'use client';

import { useEffect, useState } from 'react';

/**
 * Returns `true` on narrow (phone) viewports. Mobile-only styling in the guest
 * portal is gated on this so the desktop layout renders byte-identical markup
 * (the hook resolves to `false` on the server and on first client render,
 * matching the desktop path, then flips after mount on small screens).
 *
 * Breakpoint mirrors Tailwind's `md` (768px): below it = mobile.
 */
export function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx - 1}px)`);
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [breakpointPx]);

  return isMobile;
}
