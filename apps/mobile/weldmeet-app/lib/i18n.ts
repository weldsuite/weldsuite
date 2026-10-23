/**
 * WeldMeet strings in English and Dutch.
 *
 * WeldMeet predates a per-app catalog, so most of its copy is still inline
 * English. New strings go here, in both languages, and existing ones move in as
 * screens are touched. The language follows the phone's locale.
 *
 * The boot strings are used before any provider mounts, so this is a plain
 * module (no React context).
 */

export type MeetLanguage = 'en' | 'nl';

const en = {
  boot: {
    loading: 'Loading…',
    failedTitle: 'WeldMeet could not start',
    failedMessage:
      'WeldMeet could not reach the sign-in service. Check your internet connection and try again.',
    retry: 'Try again',
    details: 'Details',
    checking: 'Checking the connection…',
  },
};

export type MeetStrings = typeof en;

const nl: MeetStrings = {
  boot: {
    loading: 'Laden…',
    failedTitle: 'WeldMeet kon niet starten',
    failedMessage:
      'WeldMeet kon de inlogservice niet bereiken. Controleer je internetverbinding en probeer het opnieuw.',
    retry: 'Opnieuw proberen',
    details: 'Details',
    checking: 'Verbinding controleren…',
  },
};

export const MEET_STRINGS: Record<MeetLanguage, MeetStrings> = { en, nl };

/** The app language for a BCP 47 locale tag ("nl-NL" → nl); English otherwise. */
export function resolveMeetLanguage(locale: string | null | undefined): MeetLanguage {
  return locale?.toLowerCase().startsWith('nl') ? 'nl' : 'en';
}

function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

export const language: MeetLanguage = resolveMeetLanguage(deviceLocale());

export const t: MeetStrings = MEET_STRINGS[language];
