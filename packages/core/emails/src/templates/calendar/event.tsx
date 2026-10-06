/**
 * WeldCalendar attendee mail: invite, update, reschedule, cancel, "removed
 * you" (the event goes on, this guest is no longer on it) and restored (a
 * cancelled event is on again). One template with a
 * `kind`, because they share the layout and differ only in copy. The event
 * title is the heading; it is struck through once the event is off for this guest.
 * The .ics is attached by the sender, not rendered here.
 */

import {
  Actions,
  Button,
  Details,
  EmailLayout,
  Heading,
  Kicker,
  LinkFallback,
  MultilineText,
  Paragraph,
  Strong,
} from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatWhen, zoneOr } from '../../format';
import { emailStrings, fill, rich } from '../../i18n';

export type CalendarEventKind = 'invite' | 'update' | 'reschedule' | 'cancel' | 'removed' | 'restored';

export interface CalendarEventEmailProps {
  kind: CalendarEventKind;
  organizerName: string;
  title: string;
  description?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** Reschedules show the previous slot struck through. */
  oldStartTime?: string | null;
  oldEndTime?: string | null;
  location?: string | null;
  /** IANA zone the times are shown in. */
  timezone?: string | null;
  allDay?: boolean | null;
  /** Video-conference join link (WeldMeet or third-party). Ignored when the event ended for this guest. */
  meetingUrl?: string | null;
  /** Link into the authenticated WeldCalendar app. Only pass it for workspace members. */
  eventUrl?: string | null;
}

/** Mails telling the recipient the event is no longer theirs: no join or app link. */
export const isEndedKind = (kind: CalendarEventKind): boolean => kind === 'cancel' || kind === 'removed';

/** WeldMeet rooms live on meet(-env).weldsuite.org; anything else is a third-party link. */
function isWeldMeetUrl(url: string): boolean {
  try {
    return /^meet(-[a-z]+)?\.weldsuite\.org$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export default defineTemplate<CalendarEventEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldCalendar' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).calendar.subject[props.kind], { title: props.title }),

  Component: (props) => {
    const { kind, locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).calendar;
    const ended = isEndedKind(kind);
    const zone = zoneOr(props.timezone);
    const meetingUrl = ended ? undefined : props.meetingUrl?.trim() || undefined;
    const eventUrl = ended ? undefined : props.eventUrl?.trim() || undefined;

    const when = props.startTime
      ? formatWhen({ start: props.startTime, end: props.endTime, allDay: props.allDay, locale, timeZone: zone })
      : undefined;
    const was =
      kind === 'reschedule' && props.oldStartTime
        ? formatWhen({ start: props.oldStartTime, end: props.oldEndTime, allDay: props.allDay, locale, timeZone: zone })
        : undefined;

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview[kind], { organizer: props.organizerName, title: props.title })}
        footer={kind === 'invite' ? t.footer : undefined}
      >
        <Kicker>{rich(t.intro[kind], { organizer: <Strong>{props.organizerName}</Strong> })}</Kicker>
        <Heading struck={ended}>{props.title}</Heading>

        <Details
          rows={[
            { label: t.when, value: when, previous: was },
            { label: t.where, value: props.location?.trim() || undefined },
          ]}
        />

        {!ended && props.description?.trim() ? (
          <Paragraph>
            <MultilineText text={props.description.trim()} />
          </Paragraph>
        ) : null}

        {meetingUrl || eventUrl ? (
          <Actions>
            {meetingUrl ? (
              <Button accent={accent} href={meetingUrl}>{isWeldMeetUrl(meetingUrl) ? t.joinWeldMeet : t.joinVideo}</Button>
            ) : null}
            {eventUrl ? (
              <Button accent={accent} href={eventUrl} variant={meetingUrl ? 'secondary' : 'primary'}>
                {t.viewInCalendar}
              </Button>
            ) : null}
          </Actions>
        ) : null}
        {meetingUrl ? <LinkFallback label={emailStrings(locale).layout.linkFallback} href={meetingUrl} /> : null}
      </EmailLayout>
    );
  },

  previews: {
    invite: {
      props: {
        kind: 'invite',
        organizerName: 'Sanne de Vries',
        title: 'Quarterly planning',
        description: 'Agenda:\n1. Q3 results\n2. Q4 goals\n3. Hiring plan',
        startTime: '2026-10-12T13:00:00.000Z',
        endTime: '2026-10-12T14:30:00.000Z',
        location: 'Room 2.14, Amsterdam office',
        timezone: 'Europe/Amsterdam',
        meetingUrl: 'https://meet.weldsuite.org/r/abc-defg-hij',
        eventUrl: 'https://app.weldsuite.org/weldcalendar',
      },
    },
    reschedule: {
      props: {
        kind: 'reschedule',
        organizerName: 'Sanne de Vries',
        title: 'Quarterly planning',
        startTime: '2026-10-13T09:00:00.000Z',
        endTime: '2026-10-13T10:30:00.000Z',
        oldStartTime: '2026-10-12T13:00:00.000Z',
        oldEndTime: '2026-10-12T14:30:00.000Z',
        timezone: 'Europe/Amsterdam',
        meetingUrl: 'https://zoom.us/j/123456789',
      },
    },
    allDayUpdate: {
      props: {
        kind: 'update',
        organizerName: 'Tom Jansen',
        title: 'Company offsite',
        startTime: '2026-11-02T00:00:00.000Z',
        endTime: '2026-11-03T00:00:00.000Z',
        allDay: true,
        location: 'Utrecht',
        timezone: 'Europe/Amsterdam',
        eventUrl: 'https://app.weldsuite.org/weldcalendar',
      },
    },
    cancel: {
      props: {
        kind: 'cancel',
        organizerName: 'Sanne de Vries',
        title: 'Quarterly planning',
        startTime: '2026-10-12T13:00:00.000Z',
        endTime: '2026-10-12T14:30:00.000Z',
        timezone: 'Europe/Amsterdam',
        meetingUrl: 'https://meet.weldsuite.org/r/abc-defg-hij',
      },
    },
    removed: {
      props: {
        kind: 'removed',
        organizerName: 'Sanne de Vries',
        title: 'Quarterly planning',
        startTime: '2026-10-12T13:00:00.000Z',
        endTime: '2026-10-12T14:30:00.000Z',
        timezone: 'Europe/Amsterdam',
      },
    },
    restored: {
      props: {
        kind: 'restored',
        organizerName: 'Sanne de Vries',
        title: 'Quarterly planning',
        startTime: '2026-10-12T13:00:00.000Z',
        endTime: '2026-10-12T14:30:00.000Z',
        timezone: 'Europe/Amsterdam',
        meetingUrl: 'https://meet.weldsuite.org/r/abc-defg-hij',
        eventUrl: 'https://app.weldsuite.org/weldcalendar',
      },
    },
  },
});
