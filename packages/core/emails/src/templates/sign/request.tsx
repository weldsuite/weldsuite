/**
 * WeldSign: a request to review and sign a document, with the signer's
 * personal link. Sent from WeldSuite's address under the workspace's brand,
 * Reply-To the sender (sign-api, services/mail.ts).
 */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, MultilineText, Paragraph, Quote } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { formatDate } from '../../format';
import { emailStrings, fill } from '../../i18n';

export interface SignRequestEmailProps {
  /** Who sent the request (a person, or the workspace when unknown). */
  senderName: string;
  title: string;
  message?: string | null;
  /** The signer's personal link. */
  url: string;
  /** ISO time the request expires. */
  expiresAt?: string | null;
  timeZone?: string | null;
}

export default defineTemplate<SignRequestEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldSign' },

  subject: (props, { locale }) => fill(emailStrings(locale).sign.request.subject, { sender: props.senderName, title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).sign.request;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { title: props.title })} footer={t.footer}>
        <Kicker>{fill(t.kicker, { sender: props.senderName })}</Kicker>
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
        {props.expiresAt ? (
          <Paragraph muted>{fill(t.expires, { date: formatDate(props.expiresAt, locale, props.timeZone || 'UTC') })}</Paragraph>
        ) : null}
      </EmailLayout>
    );
  },

  previews: {
    withMessage: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#4f46e5' },
      props: {
        senderName: 'Gert van den Berg',
        title: 'Service agreement 2027',
        message: 'Hi Ann,\nHere is the agreement we discussed. Let me know if anything is unclear.',
        url: 'https://sign.weldsuite.org/r/abc123',
        expiresAt: '2026-11-23T12:00:00.000Z',
        timeZone: 'Europe/Amsterdam',
      },
    },
    plain: {
      brand: { kind: 'workspace', name: 'Acme Staffing' },
      props: { senderName: 'Acme Staffing', title: 'NDA', url: 'https://sign.weldsuite.org/r/def456' },
    },
  },
});
