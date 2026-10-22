/**
 * WeldMail strings in English and Dutch.
 *
 * WeldMail predates the per-app catalogs the other apps have, so most of its
 * copy is still inline English. New strings go here, in both languages, and
 * existing ones move in as screens are touched. The language follows the
 * phone's locale.
 */

export type MailLanguage = 'en' | 'nl';

const en = {
  login: {
    subtitle: 'Professional email client',
  },
  compose: {
    close: 'Close',
    send: 'Send',
    recipientRequired: 'Add at least one recipient',
    sendWithoutBodyTitle: 'Send without text?',
    sendWithoutBodyMessage: 'This email has no message text. Send it anyway?',
    sendAnyway: 'Send',
    cancel: 'Cancel',
    sendFailedTitle: 'Could not send',
    sendFailed: 'The email could not be sent. Please try again.',
    scheduleFailed: 'The email could not be scheduled. Please try again.',
  },
  settings: {
    account: 'Account',
    signedInAs: 'Signed in as',
    appearance: 'Appearance',
    theme: 'Theme',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
  },
};

export type MailStrings = typeof en;

const nl: MailStrings = {
  login: {
    subtitle: 'Professionele e-mailclient',
  },
  compose: {
    close: 'Sluiten',
    send: 'Versturen',
    recipientRequired: 'Voeg minstens één ontvanger toe',
    sendWithoutBodyTitle: 'Versturen zonder tekst?',
    sendWithoutBodyMessage: 'Deze e-mail bevat geen berichttekst. Toch versturen?',
    sendAnyway: 'Versturen',
    cancel: 'Annuleren',
    sendFailedTitle: 'Versturen mislukt',
    sendFailed: 'De e-mail kon niet worden verstuurd. Probeer het opnieuw.',
    scheduleFailed: 'De e-mail kon niet worden ingepland. Probeer het opnieuw.',
  },
  settings: {
    account: 'Account',
    signedInAs: 'Ingelogd als',
    appearance: 'Weergave',
    theme: 'Thema',
    themeSystem: 'Systeem',
    themeLight: 'Licht',
    themeDark: 'Donker',
  },
};

export const MAIL_STRINGS: Record<MailLanguage, MailStrings> = { en, nl };

/** The app language for a BCP 47 locale tag ("nl-NL" → nl); English otherwise. */
export function resolveMailLanguage(locale: string | null | undefined): MailLanguage {
  return locale?.toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

export const language: MailLanguage = resolveMailLanguage(deviceLocale());

export const t: MailStrings = MAIL_STRINGS[language];
