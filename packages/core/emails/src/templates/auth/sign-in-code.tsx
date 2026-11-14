/**
 * The second-factor code by email, on WeldSuite's own sign-in screens (EU and
 * self-hosted, ADR SEC-016). Sent by the Rust backend in place of the
 * identity provider's own email; Global signs in on Clerk.
 */

import { Code, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface AuthSignInCodeProps {
  code: string;
  expiresInMinutes?: number;
}

export default defineTemplate<AuthSignInCodeProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) => fill(emailStrings(locale).auth.signInCode.subject, { code: props.code }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).auth.signInCode;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { code: props.code })} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{t.body}</Paragraph>
        <Code>{props.code}</Code>
        <Paragraph muted>{fill(t.expires, { minutes: props.expiresInMinutes ?? 5 })}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: { code: '482913', expiresInMinutes: 5 },
    },
  },
});
