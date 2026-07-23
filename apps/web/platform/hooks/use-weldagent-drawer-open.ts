import { useState, useEffect, useCallback } from 'react';
import { isWeldAgentPanelLoaded, loadWeldAgentPanel } from '@/components/weldagent/lazy-panel';

const STORAGE_KEY = 'weldagent-open';
const CHANGE_EVENT = 'weldsuite:weldagent-open-changed';

function readFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Single source of truth for the WeldAgent drawer open state.
 *
 * - Initializes synchronously from sessionStorage so the panel survives app navigation
 *   without a flash, layout-shift, or slide-in animation.
 * - Broadcasts changes via a custom event so every component using the hook stays in sync,
 *   no matter where they sit in the React tree.
 */
export function useWeldAgentDrawerOpen() {
  const [open, setOpenState] = useState<boolean>(readFromStorage);

  useEffect(() => {
    const handler = () => setOpenState(readFromStorage());
    window.addEventListener(CHANGE_EVENT, handler);
    // Also handle native storage events from other tabs
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const setOpen = useCallback((value: boolean) => {
    const apply = () => {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, String(value));
      } catch {}
      setOpenState(value);
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    };

    // When opening, wait until the lazy panel chunk is loaded before flipping
    // the state. The page reserves its width from this same `open` flag, so if
    // we flipped before the panel was ready the layout would shift while the
    // panel was still blank — the "width adjusts but the menu appears later"
    // gap. Thanks to the idle prefetch the chunk is almost always already
    // loaded, so this resolves synchronously and both land in the same frame.
    if (value && !isWeldAgentPanelLoaded()) {
      loadWeldAgentPanel().then(apply).catch(apply);
      return;
    }

    apply();
  }, []);

  return [open, setOpen] as const;
}
