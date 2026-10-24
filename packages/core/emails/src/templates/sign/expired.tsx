/** WeldSign: a request expired before everyone signed. Goes to the sender. */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface SignExpiredEmailProps {
  title: string;
  /** Names (or emails) of the signers who had not signed. */
  unsigned: string[];
  /** The request in WeldSuite. */
  url: string;
}

export default defineTemplate<SignExpiredEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldSign' },

  subject: (props, { locale }) => fill(emailStrings(locale).sign.expired.subject, { title: props.title }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).sign.expired;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { title: props.title })}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.title}</Heading>
        <Paragraph>{t.body}</Paragraph>
        {props.unsigned.length > 0 ? <Details rows={[{ label: t.unsigned, value: props.unsigned.join(', ') }]} /> : null}
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
        unsigned: ['Bob Smith'],
        url: 'https://app.weldsuite.org/w/acme/weldsign/sgn_1',
      },
    },
  },
});
