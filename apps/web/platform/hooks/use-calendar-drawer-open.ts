import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'weldsuite.calendarDrawer.open';
const CHANGE_EVENT = 'weldsuite:calendar-drawer-open-changed';

function readFromStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Single source of truth for the calendar drawer open state.
 *
 * Broadcasts changes via a custom event so every component using the hook stays
 * in sync no matter where it sits in the tree — the header button that toggles
 * it and the `DrawerHost` that renders it are separate components, so without
 * this broadcast they'd never see each other's updates.
 */
export function useCalendarDrawerOpen() {
  const [isOpen, setIsOpen] = useState<boolean>(readFromStorage);

  useEffect(() => {
    const handler = () => setIsOpen(readFromStorage());
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
    } catch { /* best-effort only; failure is not actionable */ }
    setIsOpen(value);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  }, []);

  return [isOpen, setOpen] as const;
}
