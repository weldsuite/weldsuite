import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'meeting-panel-open';
const CHANGE_EVENT = 'weldsuite:meeting-panel-open-changed';

function readFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Single source of truth for whether any in-meeting side panel
 * (chat, info, people, settings) is currently open.
 *
 * The breadcrumb header reads it to skip the WeldAgent slide-in animation when
 * the user is switching directly from a meeting panel to the WeldAgent drawer
 * — only one panel should be visible at a time.
 */
export function useMeetingPanelOpen() {
  const [open, setOpenState] = useState<boolean>(readFromStorage);

  useEffect(() => {
    const handler = () => setOpenState(readFromStorage());
    window.addEventListener(CHANGE_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const setOpen = useCallback((value: boolean) => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, String(value));
    } catch {}
    setOpenState(value);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }, []);

  return [open, setOpen] as const;
}
