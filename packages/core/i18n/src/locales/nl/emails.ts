import type { emails as en } from '../en/emails';

/** Same shape as the English strings, so a missing key fails type-check. */
type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };

/** Dutch strings of the system emails; see `../en/emails.ts`. */
export const emails: Strings<typeof en> = {
  layout: {
    sentVia: 'Verzonden via {product}',
    linkFallback: 'Of open deze link:',
  },
  dates: {
    allDay: '{date} (hele dag)',
  },
  calendar: {
    subject: {
      invite: 'Uitnodiging: {title}',
      update: 'Gewijzigd: {title}',
      reschedule: 'Verplaatst: {title}',
      cancel: 'Geannuleerd: {title}',
      removed: 'Je bent verwijderd uit: {title}',
    },
    preview: {
      invite: '{organizer} heeft je uitgenodigd voor {title}',
      update: '{organizer} heeft {title} gewijzigd',
      reschedule: '{organizer} heeft {title} naar een nieuw tijdstip verplaatst',
      cancel: '{organizer} heeft {title} geannuleerd',
      removed: '{organizer} heeft je verwijderd uit {title}',
    },
    intro: {
      invite: '{organizer} heeft je uitgenodigd voor een afspraak.',
      update: '{organizer} heeft een afspraak gewijzigd.',
      reschedule: '{organizer} heeft een afspraak naar een nieuw tijdstip verplaatst.',
      cancel: '{organizer} heeft een afspraak geannuleerd.',
      removed: '{organizer} heeft je verwijderd uit een afspraak.',
    },
    when: 'Wanneer',
    where: 'Waar',
    joinWeldMeet: 'Deelnemen aan WeldMeet-vergadering',
    joinVideo: 'Deelnemen aan videovergadering',
    viewInCalendar: 'Bekijken in WeldCalendar',
    footer: 'Had je deze uitnodiging niet verwacht? Dan kun je deze e-mail negeren.',
  },
  booking: {
    confirmed: {
      subject: 'Afspraak bevestigd: {page} op {date}',
      preview: 'Je afspraak met {host} op {date} is bevestigd.',
      kicker: 'Afspraak bevestigd',
      intro: 'Hoi {name}, je afspraak met {host} is bevestigd. De uitnodiging zit in de bijlage, zodat je hem aan je agenda kunt toevoegen.',
    },
    host: 'Organisator',
    date: 'Datum',
    time: 'Tijd',
    location: 'Locatie',
    phone: 'Telefoon',
    videoCall: 'Videogesprek',
    joinVideoCall: 'Deelnemen aan videogesprek',
    messageFrom: 'Een bericht van {host}',
    manage: {
      withLinks: 'Iets wijzigen? Je kunt deze afspraak {reschedule} of {cancel}, of beantwoord deze e-mail om {host} te bereiken.',
      withoutLinks: 'Iets wijzigen? Beantwoord deze e-mail om {host} te bereiken.',
      reschedule: 'verplaatsen',
      cancel: 'annuleren',
    },
  },
  notifications: {
    open: 'Openen in WeldSuite',
    footer: 'Je ontvangt deze e-mail omdat e-mailmeldingen aan staan.',
    manage: 'Meldingsinstellingen',
  },
};
