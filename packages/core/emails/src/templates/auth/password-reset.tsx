/**
 * A password reset on WeldSuite's own sign-in screens (EU and self-hosted,
 * ADR SEC-016): a button to the reset page, and the code for the reset screen.
 * Sent by the Rust backend in place of the identity provider's own email;
 * Global resets passwords on Clerk.
 */

import { Actions, Button, Code, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface AuthPasswordResetProps {
  /** The account's address. */
  email: string;
  code: string;
  /** The reset page, with the code. */
  url: string;
  expiresInMinutes?: number;
}

export default defineTemplate<AuthPasswordResetProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (_props, { locale }) => emailStrings(locale).auth.passwordReset.subject,

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).auth.passwordReset;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { email: props.email })} footer={t.footer}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{t.heading}</Heading>
        <Paragraph>{fill(t.body, { email: props.email })}</Paragraph>
        <Actions>
          <Button accent={accent} href={props.url}>{t.reset}</Button>
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
        email: 'tom@example.com',
        code: 'K7Q2XR',
        url: 'https://app.weldsuite.eu/auth/reset-password?userId=399&code=K7Q2XR',
        expiresInMinutes: 60,
      },
    },
  },
});
