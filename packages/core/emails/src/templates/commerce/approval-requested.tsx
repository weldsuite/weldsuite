/**
 * WeldCommerce: an order needs approval. Goes to the approvers and admins of
 * the buyer's company, who are outside the workspace (workspace brand).
 */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export type CommerceApprovalReason = 'buyer_limit' | 'company_threshold';

export interface CommerceApprovalRequestedEmailProps {
  shopName: string;
  orderNumber: string;
  currency: string;
  total: string;
  /** Who placed the order. */
  requestedBy: string;
  companyName?: string | null;
  /** Why the order needs approval. */
  reason: CommerceApprovalReason;
  /** Absolute link to the order in the shop. Without one the email has no button. */
  shopUrl?: string | null;
}

export default defineTemplate<CommerceApprovalRequestedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldCommerce' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).commerce.approvalRequested.subject, { order: props.orderNumber }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).commerce.approvalRequested;
    const company = props.companyName?.trim();
    const url = props.shopUrl?.trim() || undefined;
    const values = {
      shop: props.shopName,
      order: props.orderNumber,
      requester: props.requestedBy,
      company: company ?? '',
      currency: props.currency,
      total: props.total,
    };
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, values)}
        footer={fill(t.footer, { shop: props.shopName })}
      >
        <Kicker>{t.kicker}</Kicker>
        <Heading>{fill(t.heading, { order: props.orderNumber })}</Heading>
        <Paragraph>{fill(company ? t.bodyCompany : t.body, values)}</Paragraph>
        <Paragraph>{t.reasons[props.reason]}</Paragraph>
        {url ? (
          <>
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
        orderNumber: 'ORD-10043',
        currency: 'EUR',
        total: '1250.00',
        requestedBy: 'Femke de Vries',
        companyName: 'Jansen Bouw BV',
        reason: 'buyer_limit',
        shopUrl: 'https://shop.acme.example/approvals/ORD-10043',
      },
    },
    minimal: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        orderNumber: 'ORD-10043',
        currency: 'EUR',
        total: '1250.00',
        requestedBy: 'Femke de Vries',
        reason: 'company_threshold',
      },
    },
  },
});
