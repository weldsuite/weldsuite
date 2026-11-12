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

/** Every string as [English, Dutch]: one table, so no key can miss a language. */
const STRINGS: Record<keyof ServerCopy, readonly [en: string, nl: string]> = {
  serverLabel: ['Server', 'Server'],
  change: ['Change', 'Wijzigen'],
  globalName: ['WeldSuite cloud', 'WeldSuite cloud'],
  euName: ['WeldSuite EU', 'WeldSuite EU'],
  selfHostedName: ['Your own server', 'Eigen server'],
  globalHint: ['The standard WeldSuite service.', 'De standaard WeldSuite-dienst.'],
  euHint: ['Your data stays in the EU, on WeldSuite’s EU servers.', 'Je gegevens blijven in de EU, op de EU-servers van WeldSuite.'],
  selfHostedHint: ['A WeldSuite server your organisation runs.', 'Een WeldSuite-server die je organisatie zelf draait.'],
  pickerTitle: ['Choose a server', 'Kies een server'],
  pickerSubtitle: ['Where does your organisation use WeldSuite?', 'Waar gebruikt je organisatie WeldSuite?'],
  addressLabel: ['Server address', 'Serveradres'],
  addressPlaceholder: ['weldsuite.example.com', 'weldsuite.voorbeeld.nl'],
  connect: ['Connect', 'Verbinden'],
  checking: ['Checking…', 'Controleren…'],
  useServer: ['Use this server', 'Deze server gebruiken'],
  cancel: ['Cancel', 'Annuleren'],
  current: ['Current', 'Huidig'],
  serverFound: ['{server} · version {version}', '{server} · versie {version}'],
  switchTitle: ['Switch server?', 'Van server wisselen?'],
  switchBody: ['{app} signs you out and restarts on {server}.', '{app} meldt je af en start opnieuw op {server}.'],
  switchConfirm: ['Switch', 'Wisselen'],
  switching: ['Switching…', 'Wisselen…'],
  invalidAddress: ['That isn’t a valid server address.', 'Dat is geen geldig serveradres.'],
  insecureAddress: ['The server must use HTTPS.', 'De server moet HTTPS gebruiken.'],
  unreachable: ['The server can’t be reached. Check the address and your connection.', 'De server is niet bereikbaar. Controleer het adres en je verbinding.'],
  notWeldsuite: ['This address isn’t a WeldSuite server.', 'Dit adres is geen WeldSuite-server.'],
  noMobileSignIn: ['This server doesn’t allow the mobile apps yet. Ask your administrator.', 'Deze server staat de mobiele apps nog niet toe. Vraag het je beheerder.'],
  appUnavailable: ['{app} isn’t available on this server.', '{app} is niet beschikbaar op deze server.'],
  bootFailedTitle: ['Can’t open {server}', '{server} kan niet worden geopend'],
  tryAgain: ['Try again', 'Opnieuw proberen'],
  useCloud: ['Use WeldSuite cloud', 'WeldSuite cloud gebruiken'],
  changeServer: ['Change server', 'Andere server kiezen'],
  hostedSignIn: ['Sign in', 'Inloggen'],
  hostedSignUp: ['Create account', 'Account aanmaken'],
  hostedHint: ['You sign in on {server}’s own sign-in page.', 'Je logt in op de eigen inlogpagina van {server}.'],
  hostedFailed: ['Sign-in failed. Please try again.', 'Inloggen is mislukt. Probeer het opnieuw.'],
  settingsSwitch: ['Switch server', 'Van server wisselen'],
  pushOff: ['Notifications aren’t available on this server yet.', 'Meldingen zijn op deze server nog niet beschikbaar.'],
  accountAtServer: ['Manage your account', 'Je account beheren'],
};

function catalog(index: 0 | 1): ServerCopy {
  const out = {} as ServerCopy;
  for (const key of Object.keys(STRINGS) as Array<keyof ServerCopy>) out[key] = STRINGS[key][index];
  return out;
}

export const SERVER_COPY: Record<ServerLanguage, ServerCopy> = { en: catalog(0), nl: catalog(1) };

/** Fill `{name}` placeholders. */
export function fillCopy(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
