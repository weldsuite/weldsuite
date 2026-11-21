/**
 * WeldForms: an invitation to fill in a form, with the person's own link, or
 * a reminder of one (`reminder`). Sent from WeldSuite's address under the
 * workspace's brand, Reply-To the sender (forms-api, services/mail.ts).
 */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, MultilineText, Paragraph, Quote } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatDate } from '../../format';
import { emailStrings, fill } from '../../i18n';

export interface FormsInviteEmailProps {
  /** Who sent the invitation (a person, or the workspace when unknown). */
  senderName: string;
  /** The form's title. */
  title: string;
  /** The sender's own subject line; the template's when empty. */
  subject?: string | null;
  message?: string | null;
  /** The person's personal link. */
  url: string;
  /** ISO time the form closes, when it does. */
  closesAt?: string | null;
  timeZone?: string | null;
  /** A reminder: the person got this invitation before and has not answered yet. */
  reminder?: boolean;
}

export default defineTemplate<FormsInviteEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldForms' },

  subject: (props, { locale }) => {
    if (!props.reminder && props.subject?.trim()) return props.subject.trim();
    const t = emailStrings(locale).forms.invite;
    return fill(props.reminder ? t.reminderSubject : t.subject, { sender: props.senderName, title: props.title });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).forms.invite;
    const preview = fill(props.reminder ? t.reminderPreview : t.preview, { title: props.title });
    return (
      <EmailLayout brand={brand} locale={locale} preview={preview} footer={t.footer}>
        <Kicker>{fill(props.reminder ? t.reminderKicker : t.kicker, { sender: props.senderName })}</Kicker>
        <Heading>{props.title}</Heading>
        {props.message?.trim() ? (
          <Quote label={fill(t.messageFrom, { sender: props.senderName })}>
            <MultilineText text={props.message} />
          </Quote>
        ) : null}
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>
            {t.button}
          </Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.url} />
        {props.closesAt ? (
          <Paragraph muted>{fill(t.closes, { date: formatDate(props.closesAt, locale, props.timeZone || 'UTC') })}</Paragraph>
        ) : null}
      </EmailLayout>
    );
  },

  previews: {
    withMessage: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#4f46e5' },
      props: {
        senderName: 'Gert van den Berg',
        title: 'Customer feedback 2027',
        message: 'Hi Ann,\nWould you take two minutes to tell us how we did?',
        url: 'https://forms.weldsuite.org/i/abcdefghij.0123456789abcdef0123',
        closesAt: '2026-11-23T12:00:00.000Z',
        timeZone: 'Europe/Amsterdam',
      },
    },
    plain: {
      brand: { kind: 'workspace', name: 'Acme Staffing' },
      props: { senderName: 'Acme Staffing', title: 'Pulse survey', url: 'https://forms.weldsuite.org/i/abcdefghij.0123456789abcdef0123' },
    },
    reminder: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#4f46e5' },
      props: {
        senderName: 'Gert van den Berg',
        title: 'Customer feedback 2027',
        url: 'https://forms.weldsuite.org/i/abcdefghij.0123456789abcdef0123',
        reminder: true,
      },
    },
  },
});
