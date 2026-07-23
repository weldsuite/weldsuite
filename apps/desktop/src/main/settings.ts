import { app } from 'electron';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

export interface DesktopSettings {
  /** Launch on system startup. */
  autoLaunch: boolean;
  /** Start hidden in the system tray instead of opening the window. */
  startMinimized: boolean;
  /** Close button hides to tray instead of quitting the app. */
  closeToTray: boolean;
  /** Enable OS-level notifications. */
  notificationsEnabled: boolean;
  /** Hardware acceleration (requires restart). */
  hardwareAcceleration: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  autoLaunch: false,
  startMinimized: false,
  closeToTray: true,
  notificationsEnabled: true,
  hardwareAcceleration: true,
};

let cache: DesktopSettings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<DesktopSettings> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    cache = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

/** Synchronous load — safe to call only AFTER `loadSettings()` has resolved once. */
export function getSettings(): DesktopSettings {
  return cache ?? DEFAULT_SETTINGS;
}

/**
 * Synchronous load used very early (before `app.whenReady()`) to pick up the
 * `hardwareAcceleration` flag, which must be applied pre-ready.
 */
export function loadSettingsSync(): DesktopSettings {
  if (cache) return cache;
  try {
    const raw = readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<DesktopSettings>;
    cache = { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    cache = { ...DEFAULT_SETTINGS };
  }
  return cache;
}

export async function saveSettings(partial: Partial<DesktopSettings>): Promise<DesktopSettings> {
  const current = await loadSettings();
  const next: DesktopSettings = { ...current, ...partial };
  cache = next;
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

/**
 * Apply settings that have immediate runtime effect. Returns the list of
 * keys whose changes require an app restart to take effect.
 */
export function applySettings(settings: DesktopSettings): Array<keyof DesktopSettings> {
  const restartRequired: Array<keyof DesktopSettings> = [];

  // Auto-launch — effective immediately via OS login items.
  app.setLoginItemSettings({
    openAtLogin: settings.autoLaunch,
    openAsHidden: settings.autoLaunch && settings.startMinimized,
    // On Windows you can pass a path + args; defaults work for the packaged app.
  });

  // Hardware acceleration — must be set before app.whenReady(). If we're
  // past that point, changes require a restart.
  if (app.isReady()) {
    restartRequired.push('hardwareAcceleration');
  } else if (!settings.hardwareAcceleration) {
    app.disableHardwareAcceleration();
  }

  return restartRequired;
}
