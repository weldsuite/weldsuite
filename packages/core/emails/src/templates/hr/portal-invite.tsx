/** WeldHR: someone was given access to the employee or client portal. */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, MultilineText, Paragraph, Quote } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface HrPortalInviteEmailProps {
  kind: 'employee' | 'client';
  portalName: string;
  recipientName?: string | null;
  recipientEmail: string;
  /** Free text the workspace configured for new portal users. */
  welcomeMessage?: string | null;
  portalUrl: string;
}

export default defineTemplate<HrPortalInviteEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldHR' },

  subject: (props, { locale }) => fill(emailStrings(locale).hrInvite.subject, { portal: props.portalName }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).hrInvite;
    const name = props.recipientName?.trim();
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, { portal: props.portalName })}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.portalName}</Heading>
        <Paragraph>{name ? fill(t.greeting, { name }) : t.greetingNoName}</Paragraph>
        <Paragraph>{props.kind === 'client' ? t.client : t.employee}</Paragraph>
        {props.welcomeMessage?.trim() ? (
          <Quote>
            <MultilineText text={props.welcomeMessage.trim()} />
          </Quote>
        ) : null}
        <Actions>
          <Button accent={accent} href={props.portalUrl}>{t.open}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.portalUrl} />
        <Paragraph muted>{fill(t.signInHint, { email: props.recipientEmail })}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    employee: {
      brand: { kind: 'workspace', name: 'Acme Staffing', accentColor: '#7c3aed' },
      props: {
        kind: 'employee',
        portalName: 'Acme employee portal',
        recipientName: 'Lisa',
        recipientEmail: 'lisa@example.com',
        welcomeMessage: 'Welcome to the team! Your first shift schedule is already in the portal.',
        portalUrl: 'https://hr.weldsuite.org/acme',
      },
    },
    clientWhiteLabel: {
      brand: { kind: 'workspace', name: 'Acme Staffing', poweredBy: false },
      props: {
        kind: 'client',
        portalName: 'Acme client portal',
        recipientEmail: 'buyer@globex.example',
        portalUrl: 'https://hr.weldsuite.org/acme',
      },
    },
  },
});
