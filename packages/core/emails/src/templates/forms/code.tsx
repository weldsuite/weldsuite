/** WeldForms: the one-time code a respondent enters on a verified-email form. */

import { Code, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface FormsCodeEmailProps {
  /** The form's title. */
  title: string;
  code: string;
  expiresInMinutes?: number;
}

export default defineTemplate<FormsCodeEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldForms' },

  subject: (props, { locale }) => fill(emailStrings(locale).forms.code.subject, { title: props.title, code: props.code }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).forms.code;
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
      props: { title: 'Customer feedback', code: '482913' },
    },
  },
});
