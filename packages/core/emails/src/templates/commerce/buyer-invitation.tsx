/**
 * WeldCommerce: a company gives a person access to order for it in a shop
 * (B2B). The recipient is outside the workspace, so callers pass the
 * workspace brand with the shop's name. There is no code or link that signs
 * anyone in: the button opens the shop, where the person asks for a one-time
 * code that is sent to this address.
 */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, Paragraph, Strong } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill, rich } from '../../i18n';

export type CommerceBuyerRole = 'buyer' | 'approver' | 'admin';

export interface CommerceBuyerInvitationEmailProps {
  shopName: string;
  companyName: string;
  /** The person who gave the access. Omitted: the email does not name anyone. */
  inviterName?: string | null;
  role: CommerceBuyerRole;
  /** Absolute link to the shop. Without one the email has no button. */
  shopUrl?: string | null;
}

export default defineTemplate<CommerceBuyerInvitationEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldCommerce' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).commerce.buyerInvitation.subject, { shop: props.shopName, company: props.companyName }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).commerce.buyerInvitation;
    const inviter = props.inviterName?.trim();
    const url = props.shopUrl?.trim() || undefined;
    const values = { shop: props.shopName, company: props.companyName, role: t.roles[props.role] };
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, values)}
        footer={fill(t.footer, { shop: props.shopName })}
      >
        <Kicker>{inviter ? rich(t.kicker, { inviter: <Strong>{inviter}</Strong> }) : t.kickerNoInviter}</Kicker>
        <Heading>{props.shopName}</Heading>
        <Paragraph>{fill(t.body, values)}</Paragraph>
        {url ? (
          <>
            <Paragraph>{t.signIn}</Paragraph>
            <Actions>
              <Button accent={accent} href={url}>{t.open}</Button>
            </Actions>
            <LinkFallback label={emailStrings(locale).layout.linkFallback} href={url} />
          </>
        ) : null}
      </EmailLayout>
    );
  },

  previews: {
    full: {
      brand: { kind: 'workspace', name: 'Acme Wholesale', accentColor: '#2563eb' },
      props: {
        shopName: 'Acme Wholesale',
        companyName: 'Jansen Bouw BV',
        inviterName: 'Sanne Jansen',
        role: 'buyer',
        shopUrl: 'https://shop.acme.example/',
      },
    },
    approver: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        companyName: 'Jansen Bouw BV',
        role: 'approver',
        shopUrl: 'https://shop.acme.example/',
      },
    },
    admin: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        companyName: 'Jansen Bouw BV',
        inviterName: 'Sanne Jansen',
        role: 'admin',
      },
    },
  },
});
