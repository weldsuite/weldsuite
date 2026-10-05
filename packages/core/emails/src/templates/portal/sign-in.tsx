/**
 * Sign-in code (and optionally a magic link) for the customer-facing portals:
 * the WeldHR employee/client portal (code only) and the WeldCommerce order
 * portal (link + code). Carries the portal's / workspace's brand.
 */

import { Actions, Button, Code, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface PortalSignInEmailProps {
  /** Name of the portal as the recipient knows it ("Acme order portal"). */
  portalName: string;
  code: string;
  /** Magic link; when set, the email leads with a sign-in button. */
  url?: string | null;
  expiresInMinutes?: number;
}

export default defineTemplate<PortalSignInEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).portal.subject;
    return props.url
      ? fill(t.link, { portal: props.portalName })
      : fill(t.code, { portal: props.portalName, code: props.code });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).portal;
    const url = props.url?.trim() || undefined;
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { code: props.code })}
        footer={t.footer}
      >
        <Kicker>{url ? t.kickerLink : t.kickerCode}</Kicker>
        <Heading>{props.portalName}</Heading>
        {url ? (
          <>
            <Actions>
              <Button accent={accent} href={url}>{t.signIn}</Button>
            </Actions>
            <LinkFallback label={emailStrings(locale).layout.linkFallback} href={url} />
          </>
        ) : null}
        <Paragraph>{url ? t.useLink : t.useCode}</Paragraph>
        <Code>{props.code}</Code>
        <Paragraph muted>{fill(url ? t.expiresLink : t.expiresCode, { minutes: props.expiresInMinutes ?? 15 })}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    code: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#7c3aed' },
      props: { portalName: 'Acme employee portal', code: '482913' },
    },
    linkAndCode: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        portalName: 'Acme order portal',
        code: '771204',
        url: 'https://portal.weldsuite.org/acme/auth/callback?token=abc',
      },
    },
  },
});
