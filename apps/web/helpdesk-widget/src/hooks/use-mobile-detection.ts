/**
 * Mobile Detection Hook
 * Detects if the current viewport is mobile-sized (<768px)
 */

import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;

/**
 * Hook to detect mobile viewport
 * @returns true if viewport width is less than 768px
 */
export function useMobileDetection(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };

    // Check on mount
    checkMobile();

    // Listen for resize events
    window.addEventListener('resize', checkMobile);

    // Also listen for orientation changes on mobile
    window.addEventListener('orientationchange', checkMobile);

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener('orientationchange', checkMobile);
    };
  }, []);

  return isMobile;
}
