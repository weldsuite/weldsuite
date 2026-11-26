/**
 * The shell's own words: the tray and the macOS app menu. The pages it shows
 * itself (renderer/shared/strings.ts) have theirs. English and Dutch, like the
 * platform's complete locales; anything else gets English.
 */
const STRINGS = {
  en: {
    open: 'Open WeldSuite',
    reload: 'Reload',
    server: 'Server: {host}',
    changeServer: 'Change server…',
    checkForUpdates: 'Check for updates',
    quit: 'Quit',
  },
  nl: {
    open: 'WeldSuite openen',
    reload: 'Opnieuw laden',
    server: 'Server: {host}',
    changeServer: 'Server wijzigen…',
    checkForUpdates: 'Controleren op updates',
    quit: 'Afsluiten',
  },
} as const;

export type ShellString = keyof (typeof STRINGS)['en'];

/** `nl` for a Dutch system language, else `en`. */
export function shellLocale(systemLocale: string): keyof typeof STRINGS {
  return systemLocale.toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

export function shellText(systemLocale: string, key: ShellString, values: Record<string, string> = {}): string {
  const template: string = STRINGS[shellLocale(systemLocale)][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
