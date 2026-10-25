/** WeldSign: a signer declined. Goes to the sender, with the signer's reason. */

import { Actions, Button, EmailLayout, Heading, Kicker, MultilineText, Paragraph, Quote } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface SignDeclinedEmailProps {
  title: string;
  /** Name (or email) of the signer who declined. */
  declinedBy: string;
  reason: string;
  /** The request in WeldSuite. */
  url: string;
}

export default defineTemplate<SignDeclinedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldSign' },

  subject: (props, { locale }) => fill(emailStrings(locale).sign.declined.subject, { name: props.declinedBy, title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).sign.declined;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { name: props.declinedBy })}>
        <Kicker>{fill(t.kicker, { name: props.declinedBy })}</Kicker>
        <Heading>{props.title}</Heading>
        <Quote label={t.reason}>
          <MultilineText text={props.reason} />
        </Quote>
        <Paragraph>{t.body}</Paragraph>
        <Actions>
          <Button href={props.url}>{t.open}</Button>
        </Actions>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        title: 'Service agreement 2027',
        declinedBy: 'Bob Smith',
        reason: 'The notice period in clause 4 is not what we agreed.',
        url: 'https://app.weldsuite.org/w/acme/weldsign/sgn_1',
      },
    },
  },
});
