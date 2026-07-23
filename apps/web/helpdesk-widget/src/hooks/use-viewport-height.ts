/**
 * Viewport Height Hook
 * Handles dynamic viewport height for mobile browsers
 * Accounts for URL bar, keyboard, and browser navigation
 */

import { useState, useEffect } from 'react';

/**
 * Hook to get accurate viewport height on mobile
 * Uses visualViewport API when available, falls back to window.innerHeight
 * Updates when URL bar shows/hides or keyboard opens
 */
export function useViewportHeight(): { height: number; offsetTop: number } {
  const [viewport, setViewport] = useState({ height: 0, offsetTop: 0 });

  useEffect(() => {
    const updateViewport = () => {
      if (window.visualViewport) {
        setViewport({
          height: window.visualViewport.height,
          offsetTop: window.visualViewport.offsetTop,
        });
      } else {
        setViewport({
          height: window.innerHeight,
          offsetTop: 0,
        });
      }
    };

    // Initial update
    updateViewport();

    // Listen for viewport changes
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewport);
      window.visualViewport.addEventListener('scroll', updateViewport);
    }
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateViewport);
        window.visualViewport.removeEventListener('scroll', updateViewport);
      }
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
    };
  }, []);

  return viewport;
}
