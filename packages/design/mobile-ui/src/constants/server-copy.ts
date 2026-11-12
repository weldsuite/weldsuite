/**
 * Copy for choosing a server (WeldSuite cloud, EU, self-hosted) and signing
 * in on one that hosts its own sign-in, in every language the mobile apps
 * ship. Same pattern as `login-copy.ts`: pick a catalog with `language`,
 * override single strings with `copy`. `{app}`, `{server}` and `{version}`
 * are filled in by the components.
 */

export type ServerLanguage = 'en' | 'nl';

export interface ServerCopy {
  /** Row under the sign-in form and in settings. */
  serverLabel: string;
  change: string;
  globalName: string;
  euName: string;
  selfHostedName: string;
  globalHint: string;
  euHint: string;
  selfHostedHint: string;

  /** Picker sheet. */
  pickerTitle: string;
  pickerSubtitle: string;
  addressLabel: string;
  addressPlaceholder: string;
  connect: string;
  checking: string;
  useServer: string;
  cancel: string;
  current: string;
  /** Shown after a successful check: "{server} · version {version}". */
  serverFound: string;
  switchTitle: string;
  switchBody: string;
  switchConfirm: string;
  switching: string;

  /** Why a server can't be used. */
  invalidAddress: string;
  insecureAddress: string;
  unreachable: string;
  notWeldsuite: string;
  noMobileSignIn: string;
  appUnavailable: string;

  /** Boot gate. */
  bootFailedTitle: string;
  tryAgain: string;
  useCloud: string;
  changeServer: string;

  /** Sign-in on a server that hosts its own sign-in page. */
  hostedSignIn: string;
  hostedSignUp: string;
  hostedHint: string;
  hostedFailed: string;

  /** Settings. */
  settingsSwitch: string;
  pushOff: string;
  accountAtServer: string;
}

const en: ServerCopy = {
  serverLabel: 'Server',
  change: 'Change',
  globalName: 'WeldSuite cloud',
  euName: 'WeldSuite EU',
  selfHostedName: 'Your own server',
  globalHint: 'The standard WeldSuite service.',
  euHint: 'Your data stays in the EU, on WeldSuite’s EU servers.',
  selfHostedHint: 'A WeldSuite server your organisation runs.',

  pickerTitle: 'Choose a server',
  pickerSubtitle: 'Where does your organisation use WeldSuite?',
  addressLabel: 'Server address',
  addressPlaceholder: 'weldsuite.example.com',
  connect: 'Connect',
  checking: 'Checking…',
  useServer: 'Use this server',
  cancel: 'Cancel',
  current: 'Current',
  serverFound: '{server} · version {version}',
  switchTitle: 'Switch server?',
  switchBody: '{app} signs you out and restarts on {server}.',
  switchConfirm: 'Switch',
  switching: 'Switching…',

  invalidAddress: 'That isn’t a valid server address.',
  insecureAddress: 'The server must use HTTPS.',
  unreachable: 'The server can’t be reached. Check the address and your connection.',
  notWeldsuite: 'This address isn’t a WeldSuite server.',
  noMobileSignIn: 'This server doesn’t allow the mobile apps yet. Ask your administrator.',
  appUnavailable: '{app} isn’t available on this server.',

  bootFailedTitle: 'Can’t open {server}',
  tryAgain: 'Try again',
  useCloud: 'Use WeldSuite cloud',
  changeServer: 'Change server',

  hostedSignIn: 'Sign in',
  hostedSignUp: 'Create account',
  hostedHint: 'You sign in on {server}’s own sign-in page.',
  hostedFailed: 'Sign-in failed. Please try again.',

  settingsSwitch: 'Switch server',
  pushOff: 'Notifications aren’t available on this server yet.',
  accountAtServer: 'Manage your account',
};

const nl: ServerCopy = {
  serverLabel: 'Server',
  change: 'Wijzigen',
  globalName: 'WeldSuite cloud',
  euName: 'WeldSuite EU',
  selfHostedName: 'Eigen server',
  globalHint: 'De standaard WeldSuite-dienst.',
  euHint: 'Je gegevens blijven in de EU, op de EU-servers van WeldSuite.',
  selfHostedHint: 'Een WeldSuite-server die je organisatie zelf draait.',

  pickerTitle: 'Kies een server',
  pickerSubtitle: 'Waar gebruikt je organisatie WeldSuite?',
  addressLabel: 'Serveradres',
  addressPlaceholder: 'weldsuite.voorbeeld.nl',
  connect: 'Verbinden',
  checking: 'Controleren…',
  useServer: 'Deze server gebruiken',
  cancel: 'Annuleren',
  current: 'Huidig',
  serverFound: '{server} · versie {version}',
  switchTitle: 'Van server wisselen?',
  switchBody: '{app} meldt je af en start opnieuw op {server}.',
  switchConfirm: 'Wisselen',
  switching: 'Wisselen…',

  invalidAddress: 'Dat is geen geldig serveradres.',
  insecureAddress: 'De server moet HTTPS gebruiken.',
  unreachable: 'De server is niet bereikbaar. Controleer het adres en je verbinding.',
  notWeldsuite: 'Dit adres is geen WeldSuite-server.',
  noMobileSignIn: 'Deze server staat de mobiele apps nog niet toe. Vraag het je beheerder.',
  appUnavailable: '{app} is niet beschikbaar op deze server.',

  bootFailedTitle: '{server} kan niet worden geopend',
  tryAgain: 'Opnieuw proberen',
  useCloud: 'WeldSuite cloud gebruiken',
  changeServer: 'Andere server kiezen',

  hostedSignIn: 'Inloggen',
  hostedSignUp: 'Account aanmaken',
  hostedHint: 'Je logt in op de eigen inlogpagina van {server}.',
  hostedFailed: 'Inloggen is mislukt. Probeer het opnieuw.',

  settingsSwitch: 'Van server wisselen',
  pushOff: 'Meldingen zijn op deze server nog niet beschikbaar.',
  accountAtServer: 'Je account beheren',
};

export const SERVER_COPY: Record<ServerLanguage, ServerCopy> = { en, nl };

/** Fill `{name}` placeholders. */
export function fillCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
