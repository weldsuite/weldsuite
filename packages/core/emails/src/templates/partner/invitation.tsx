/** Invitation to the partner (reseller) portal. */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, Paragraph, Strong } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill, rich } from '../../i18n';
import { partnerStrings } from './copy';

export interface PartnerInvitationEmailProps {
  partnerName: string;
  role: 'owner' | 'admin' | 'billing' | 'viewer';
  /** Where the invitee signs in, e.g. https://app.weldsuite.org/partner. */
  portalUrl: string;
  recipientEmail: string;
}

export default defineTemplate<PartnerInvitationEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(partnerStrings[locale].invitation.subject, { partner: props.partnerName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = partnerStrings[locale].invitation;
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { partner: props.partnerName })}
        footer={fill(t.footer, { email: props.recipientEmail })}
      >
        <Kicker>{t.kicker}</Kicker>
        <Heading>{props.partnerName}</Heading>
        <Paragraph>
          {rich(t.body, { partner: props.partnerName, role: <Strong>{t.roles[props.role]}</Strong> })}
        </Paragraph>
        <Actions>
          <Button accent={accentOf(brand)} href={props.portalUrl}>{t.open}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.portalUrl} />
      </EmailLayout>
    );
  },

  previews: {
    default: {
      props: {
        partnerName: 'Andes Cloud SAS',
        role: 'owner',
        portalUrl: 'https://app.weldsuite.org/partner',
        recipientEmail: 'ana@andes.example',
      },
    },
  },
});
