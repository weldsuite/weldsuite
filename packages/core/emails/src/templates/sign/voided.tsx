/**
 * WeldSign: the sender voided a request. Goes to the signers who already got
 * it, with the sender's reason, under the workspace's brand.
 */

import { EmailLayout, Heading, Kicker, MultilineText, Paragraph, Quote } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface SignVoidedEmailProps {
  /** Who sent (and voided) the request. */
  senderName: string;
  title: string;
  reason: string;
}

export default defineTemplate<SignVoidedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldSign' },

  subject: (props, { locale }) => fill(emailStrings(locale).sign.voided.subject, { title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).sign.voided;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { sender: props.senderName })}>
        <Kicker>{fill(t.kicker, { sender: props.senderName })}</Kicker>
        <Heading>{props.title}</Heading>
        <Quote label={t.reason}>
          <MultilineText text={props.reason} />
        </Quote>
        <Paragraph>{t.body}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#4f46e5' },
      props: {
        senderName: 'Gert van den Berg',
        title: 'Service agreement 2027',
        reason: 'We sent the wrong version. A corrected agreement follows today.',
      },
    },
  },
});
