/**
 * WeldMeet: someone was added to a meeting and gets the public join link. The
 * sender attaches an .ics when the meeting has a scheduled time.
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

export interface MeetInvitationEmailProps {
  organizerName: string;
  title: string;
  description?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  /** IANA zone the time is shown in (the recipient's or the organizer's). */
  timezone?: string | null;
  /** Public join link; no account needed. */
  joinUrl: string;
}

export default defineTemplate<MeetInvitationEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldMeet' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).meet.subject, { organizer: props.organizerName, title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).meet;
    const when = props.startTime
      ? formatWhen({ start: props.startTime, end: props.endTime, locale, timeZone: zoneOr(props.timezone) })
      : undefined;

    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.subject, { organizer: props.organizerName, title: props.title })}
        footer={t.footer}
      >
        <Kicker>{rich(t.intro, { organizer: <Strong>{props.organizerName}</Strong> })}</Kicker>
        <Heading>{props.title}</Heading>
        <Details rows={[{ label: t.when, value: when }]} />
        {props.description?.trim() ? (
          <Paragraph>
            <MultilineText text={props.description.trim()} />
          </Paragraph>
        ) : null}
        <Actions>
          <Button accent={accent} href={props.joinUrl}>{t.join}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.joinUrl} />
        <Paragraph muted>{t.noAccount}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    scheduled: {
      props: {
        organizerName: 'Sanne de Vries',
        title: 'Design review',
        description: 'Walkthrough of the new onboarding flow.',
        startTime: '2026-10-12T13:00:00.000Z',
        endTime: '2026-10-12T13:45:00.000Z',
        timezone: 'Europe/Amsterdam',
        joinUrl: 'https://meet.weldsuite.org/ws_123/abc-defg-hij',
      },
    },
    instant: {
      props: {
        organizerName: 'Sanne de Vries',
        title: 'Quick sync',
        joinUrl: 'https://meet.weldsuite.org/ws_123/abc-defg-hij',
      },
    },
  },
});
