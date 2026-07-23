import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'weldsuite.notificationsPanel.open';
const CHANGE_EVENT = 'weldsuite:notifications-panel-open-changed';

function readFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Single source of truth for the notifications panel open state.
 *
 * Broadcasts changes via a custom event so every component using the hook stays
 * in sync no matter where it sits in the tree — the header button that toggles
 * it and the `DrawerHost` that renders it are separate components, so without
 * this broadcast they'd never see each other's updates.
 */
export function useNotificationsPanelOpen() {
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
      window.sessionStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch {}
    setOpenState(value);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }, []);

  return [open, setOpen] as const;
}
