import { useEffect, useState, useCallback } from 'react';
import { getDesktop, isDesktop } from '@/lib/desktop';
import type { DesktopSettings } from '../types/weldsuite-desktop';

interface UseDesktopSettings {
  settings: DesktopSettings | null;
  loading: boolean;
  restartRequired: Array<keyof DesktopSettings>;
  update: (partial: Partial<DesktopSettings>) => Promise<void>;
  relaunch: () => Promise<void>;
}

/**
 * React hook for reading + updating the desktop shell's persistent settings.
 * Returns `null` settings when running in the web (non-Electron) build.
 */
export function useDesktopSettings(): UseDesktopSettings {
  const desktop = getDesktop();
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [restartRequired, setRestartRequired] = useState<Array<keyof DesktopSettings>>([]);

  useEffect(() => {
    if (!desktop) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    desktop.settings.get().then((s) => {
      if (!cancelled) {
        setSettings(s);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [desktop]);

  const update = useCallback(async (partial: Partial<DesktopSettings>) => {
    if (!desktop) return;
    const res = await desktop.settings.set(partial);
    setSettings(res.settings);
    if (res.restartRequired.length) {
      setRestartRequired((prev) => Array.from(new Set([...prev, ...res.restartRequired])));
    }
  }, [desktop]);

  const relaunch = useCallback(async () => {
    await desktop?.relaunch();
  }, [desktop]);

  return { settings, loading, restartRequired, update, relaunch };
}

;
