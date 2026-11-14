/**
 * Confirms the address of a new account on WeldSuite's own sign-in screens
 * (EU and self-hosted, ADR SEC-016): a button that verifies it in one click,
 * and the code for the sign-in screen. Sent by the Rust backend in place of
 * the identity provider's own email; Global signs up on Clerk.
 */

import { Actions, Button, Code, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface AuthVerifyEmailProps {
  code: string;
  /** Verifies the address when opened. */
  url: string;
  expiresInMinutes?: number;
}

export default defineTemplate<AuthVerifyEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (_props, { locale }) => emailStrings(locale).auth.verifyEmail.subject,

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).auth.verifyEmail;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { code: props.code })} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{t.body}</Paragraph>
        <Actions>
          <Button accent={accent} href={props.url}>{t.confirm}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.url} />
        <Paragraph>{t.useCode}</Paragraph>
        <Code>{props.code}</Code>
        <Paragraph muted>{fill(t.expires, { minutes: props.expiresInMinutes ?? 60 })}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        code: 'K7Q2XR',
        url: 'https://app.weldsuite.eu/auth/login?verifyUser=399&verifyCode=K7Q2XR',
        expiresInMinutes: 60,
      },
    },
  },
});
