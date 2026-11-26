/**
 * Words on the pages the shell shows itself, before any server answers:
 * "Change server…" (server/) and the page for a server it can't reach
 * (offline/). English and Dutch, picked from the system language.
 */
const STRINGS = {
  en: {
    serverTitle: 'Change server',
    serverHeading: 'Where do you use WeldSuite?',
    serverLead: 'The app opens WeldSuite from this server. You sign in there.',
    serverLegend: 'Server',
    defaultTitle: 'WeldSuite EU',
    otherTitle: 'Another server',
    otherDetail: 'A self-hosted WeldSuite, or a test server',
    addressLabel: 'Server address',
    addressHint: 'For example weldsuite.example.com',
    locked: 'DESKTOP_APP_URL sets the server ({host}), so it can’t be changed here.',
    cancel: 'Cancel',
    connect: 'Connect',
    checking: 'Checking {host}…',
    errorEmpty: 'Enter the address of a WeldSuite server.',
    errorInvalid: 'That isn’t a server address. Use https, for example weldsuite.example.com.',
    errorUnreachable: 'Can’t reach {host}. Check the address and your internet connection.',
    errorNotWeldsuite: '{host} isn’t a WeldSuite server the desktop app can sign in to.',
    errorLocked: 'DESKTOP_APP_URL sets the server, so it can’t be changed here.',
    offlineTitle: 'Can’t reach WeldSuite',
    offlineHeading: 'Can’t reach {host}',
    offlineBody: 'Check your internet connection. WeldSuite opens again as soon as you’re back online.',
    offlineRetry: 'Try again',
    offlineChangeServer: 'Change server…',
    offlineDetail: 'Error: {error}',
  },
  nl: {
    serverTitle: 'Server wijzigen',
    serverHeading: 'Waar gebruik je WeldSuite?',
    serverLead: 'De app opent WeldSuite vanaf deze server. Daar log je in.',
    serverLegend: 'Server',
    defaultTitle: 'WeldSuite EU',
    otherTitle: 'Een andere server',
    otherDetail: 'Een eigen WeldSuite-installatie, of een testserver',
    addressLabel: 'Serveradres',
    addressHint: 'Bijvoorbeeld weldsuite.voorbeeld.nl',
    locked: 'DESKTOP_APP_URL bepaalt de server ({host}), dus je kunt hem hier niet wijzigen.',
    cancel: 'Annuleren',
    connect: 'Verbinden',
    checking: '{host} controleren…',
    errorEmpty: 'Vul het adres van een WeldSuite-server in.',
    errorInvalid: 'Dat is geen serveradres. Gebruik https, bijvoorbeeld weldsuite.voorbeeld.nl.',
    errorUnreachable: '{host} is niet bereikbaar. Controleer het adres en je internetverbinding.',
    errorNotWeldsuite: '{host} is geen WeldSuite-server waarop de desktop-app kan inloggen.',
    errorLocked: 'DESKTOP_APP_URL bepaalt de server, dus je kunt hem hier niet wijzigen.',
    offlineTitle: 'WeldSuite is niet bereikbaar',
    offlineHeading: '{host} is niet bereikbaar',
    offlineBody: 'Controleer je internetverbinding. WeldSuite opent weer zodra je online bent.',
    offlineRetry: 'Opnieuw proberen',
    offlineChangeServer: 'Server wijzigen…',
    offlineDetail: 'Fout: {error}',
  },
} as const;

export type PageString = keyof (typeof STRINGS)['en'];

export const locale: keyof typeof STRINGS = navigator.language.toLowerCase().startsWith('nl') ? 'nl' : 'en';

export function text(key: PageString, values: Record<string, string> = {}): string {
  const template: string = STRINGS[locale][key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/** Fill every `[data-text]` element with its string, and set the page's language. */
export function applyText(root: ParentNode = document): void {
  document.documentElement.lang = locale;
  for (const element of root.querySelectorAll<HTMLElement>('[data-text]')) {
    element.textContent = text(element.dataset.text as PageString);
  }
}
