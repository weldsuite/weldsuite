/** Invitation to join a workspace (sent from the Clerk invitation webhook). */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, Paragraph, Strong } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill, rich } from '../../i18n';

export interface WorkspaceInvitationEmailProps {
  inviterName: string;
  workspaceName: string;
  /** Display name of the role, e.g. "Admin". */
  role: string;
  acceptUrl: string;
  recipientEmail: string;
}

export default defineTemplate<WorkspaceInvitationEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).workspaceInvite.subject, {
      inviter: props.inviterName,
      workspace: props.workspaceName,
    }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).workspaceInvite;
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { workspace: props.workspaceName })}
        footer={fill(t.footer, { email: props.recipientEmail })}
      >
        <Kicker>{rich(t.intro, { inviter: <Strong>{props.inviterName}</Strong> })}</Kicker>
        <Heading>{props.workspaceName}</Heading>
        <Paragraph>
          {rich(t.body, { workspace: props.workspaceName, role: <Strong>{props.role}</Strong> })}
        </Paragraph>
        <Actions>
          <Button accent={accent} href={props.acceptUrl}>{t.accept}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.acceptUrl} />
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        inviterName: 'Sanne de Vries',
        workspaceName: 'Acme Studio',
        role: 'Member',
        acceptUrl: 'https://accounts.weldsuite.org/accept?ticket=abc',
        recipientEmail: 'tom@example.com',
      },
    },
  },
});
