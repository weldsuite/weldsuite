/**
 * WeldFlow: a CRM contact is invited to the client project portal (FLOW-020).
 * The recipient is outside the workspace, so callers pass the workspace brand.
 * There is no link that signs anyone in: the button opens the portal, where
 * the contact asks for a one-time code that is sent to this address.
 */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, Paragraph, Strong } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill, rich } from '../../i18n';

export interface FlowPortalInvitationEmailProps {
  /** Greeting name. Omitted: the email opens without one. */
  contactName?: string | null;
  projectName: string;
  /** The workspace member who sent the invitation. */
  invitedBy?: string | null;
  workspaceName: string;
  /** Absolute link to the project in the portal. */
  url: string;
}

export default defineTemplate<FlowPortalInvitationEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldFlow' },

  subject: (props, { locale }) => fill(emailStrings(locale).portalInvite.subject, { project: props.projectName }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).portalInvite;
    const name = props.contactName?.trim();
    const inviter = props.invitedBy?.trim();
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={inviter ? fill(t.preview, { inviter, project: props.projectName }) : fill(t.previewNoInviter, { project: props.projectName })}
        footer={fill(t.footer, { workspace: props.workspaceName })}
      >
        <Kicker>{inviter ? rich(t.kicker, { inviter: <Strong>{inviter}</Strong> }) : t.kickerNoInviter}</Kicker>
        <Heading>{props.projectName}</Heading>
        <Paragraph>{name ? fill(t.greeting, { name }) : t.greetingNoName}</Paragraph>
        <Paragraph>{fill(t.body, { workspace: props.workspaceName })}</Paragraph>
        <Paragraph>{t.signIn}</Paragraph>
        <Actions>
          <Button accent={accent} href={props.url}>{t.open}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.url} />
      </EmailLayout>
    );
  },

  previews: {
    full: {
      brand: { kind: 'workspace', name: 'Acme Studio', accentColor: '#2563eb' },
      props: {
        contactName: 'Femke',
        projectName: 'Customer Portal Relaunch',
        invitedBy: 'Sanne Jansen',
        workspaceName: 'Acme Studio',
        url: 'https://projects.weldsuite.org/ws_acme/projects/proj_1',
      },
    },
    minimal: {
      brand: { kind: 'workspace', name: 'Acme Studio' },
      props: {
        projectName: 'Customer Portal Relaunch',
        workspaceName: 'Acme Studio',
        url: 'https://projects.weldsuite.org/ws_acme/projects/proj_1',
      },
    },
  },
});
