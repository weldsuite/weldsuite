/** WeldSign: the one-time code a signer enters to open a document (auth mode `email_code`). */

import { Code, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface SignCodeEmailProps {
  title: string;
  code: string;
  expiresInMinutes?: number;
}

export default defineTemplate<SignCodeEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldSign' },

  subject: (props, { locale }) => fill(emailStrings(locale).sign.code.subject, { title: props.title, code: props.code }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).sign.code;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { code: props.code })} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.title}</Heading>
        <Paragraph>{t.body}</Paragraph>
        <Code>{props.code}</Code>
        <Paragraph muted>{fill(t.expires, { minutes: props.expiresInMinutes ?? 10 })}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#4f46e5' },
      props: { title: 'Service agreement 2027', code: '482913' },
    },
  },
});
