/**
 * Booking portal: sent to the person who booked a meeting. Customer-facing, so
 * it carries the workspace's brand; the sender sets Reply-To to the host and
 * attaches the .ics.
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
  Quote,
  Strong,
  TextLink,
} from '../../components';
import { defineTemplate } from '../../define';
import { formatDate, formatTimeRange, zoneOr } from '../../format';
import { emailStrings, fill, rich, type EmailStrings } from '../../i18n';

/** Where the meeting happens, already resolved by the sender. */
export type BookingLocation =
  | { type: 'video'; joinUrl?: string | null }
  | { type: 'phone'; value: string }
  | { type: 'in-person'; value: string };

export interface BookingConfirmedEmailProps {
  bookerName: string;
  bookingPageName: string;
  workspaceName: string;
  /** The member who owns the booking page; the workspace name stands in when unset. */
  hostName?: string | null;
  startTime: string;
  endTime: string;
  /** IANA zone of the booker. */
  timezone?: string | null;
  location?: BookingLocation | null;
  /** Free text the host configured on the booking page. */
  confirmationMessage?: string | null;
  /** Signed links into the portal's reschedule / cancel flow. */
  rescheduleUrl?: string | null;
  cancelUrl?: string | null;
}

/** "Jane Doe (Acme)" when the host is a person, otherwise just the workspace. */
export function hostLabel(hostName: string | null | undefined, workspaceName: string): string {
  const host = hostName?.trim();
  return host && host !== workspaceName ? `${host} (${workspaceName})` : workspaceName;
}

function locationRow(location: BookingLocation | null | undefined, t: EmailStrings['booking']) {
  if (!location) return undefined;
  if (location.type === 'video') return { label: t.location, value: t.videoCall };
  const value = location.value.trim();
  if (!value) return undefined;
  return { label: location.type === 'phone' ? t.phone : t.location, value };
}

export default defineTemplate<BookingConfirmedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldCalendar' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).booking.confirmed.subject, {
      page: props.bookingPageName,
      date: formatDate(props.startTime, locale, zoneOr(props.timezone)),
    }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).booking;
    const zone = zoneOr(props.timezone);
    const host = hostLabel(props.hostName, props.workspaceName);
    const contact = props.hostName?.trim() || props.workspaceName;
    const joinUrl = props.location?.type === 'video' ? props.location.joinUrl?.trim() || undefined : undefined;
    const date = formatDate(props.startTime, locale, zone);
    const location = locationRow(props.location, t);

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.confirmed.preview, { host, date })}
      >
        <Kicker>{t.confirmed.kicker}</Kicker>
        <Heading>{props.bookingPageName}</Heading>
        <Paragraph>
          {rich(t.confirmed.intro, { name: props.bookerName, host: <Strong>{host}</Strong> })}
        </Paragraph>

        <Details
          rows={[
            { label: t.date, value: date },
            { label: t.time, value: formatTimeRange(props.startTime, props.endTime, locale, zone) },
            { label: t.host, value: host },
            ...(location ? [location] : []),
          ]}
        />

        {joinUrl ? (
          <>
            <Actions>
              <Button href={joinUrl}>{t.joinVideoCall}</Button>
            </Actions>
            <LinkFallback href={joinUrl} />
          </>
        ) : null}

        {props.confirmationMessage?.trim() ? (
          <Quote label={fill(t.messageFrom, { host: contact })}>
            <MultilineText text={props.confirmationMessage.trim()} />
          </Quote>
        ) : null}

        <Paragraph muted>
          {props.rescheduleUrl && props.cancelUrl
            ? rich(t.manage.withLinks, {
                host: contact,
                reschedule: <TextLink href={props.rescheduleUrl}>{t.manage.reschedule}</TextLink>,
                cancel: <TextLink href={props.cancelUrl}>{t.manage.cancel}</TextLink>,
              })
            : fill(t.manage.withoutLinks, { host: contact })}
        </Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    video: {
      brand: { kind: 'workspace', name: 'Acme Studio', accentColor: '#0f9d76' },
      props: {
        bookerName: 'Lisa Bakker',
        bookingPageName: '30 minute intro call',
        workspaceName: 'Acme Studio',
        hostName: 'Mark Visser',
        startTime: '2026-10-14T08:30:00.000Z',
        endTime: '2026-10-14T09:00:00.000Z',
        timezone: 'Europe/Amsterdam',
        location: { type: 'video', joinUrl: 'https://meet.weldsuite.org/r/xyz-abcd-efg' },
        confirmationMessage: 'Looking forward to it!\nPlease have your project brief ready.',
        rescheduleUrl: 'https://book.weldsuite.org/manage/abc?action=reschedule',
        cancelUrl: 'https://book.weldsuite.org/manage/abc?action=cancel',
      },
    },
    inPersonWithLogo: {
      brand: {
        kind: 'workspace',
        name: 'Acme Studio',
        logoUrl: 'https://app.weldsuite.org/email/weldsuite-logo.png',
      },
      props: {
        bookerName: 'Lisa Bakker',
        bookingPageName: 'Studio visit',
        workspaceName: 'Acme Studio',
        startTime: '2026-10-14T12:00:00.000Z',
        endTime: '2026-10-14T13:00:00.000Z',
        timezone: 'Europe/Amsterdam',
        location: { type: 'in-person', value: 'Keizersgracht 123, Amsterdam' },
      },
    },
  },
});
