/**
 * WeldCommerce: an approver approved or rejected the buyer's order. An
 * approved order that is not on invoice carries a link to pay it.
 */

import { Actions, Button, EmailLayout, Heading, Kicker, LinkFallback, MultilineText, Paragraph, Quote } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface CommerceApprovalDecidedEmailProps {
  shopName: string;
  orderNumber: string;
  currency: string;
  total: string;
  approved: boolean;
  /** The approver. Omitted: the email does not name anyone. */
  decidedBy?: string | null;
  /** The approver's comment, quoted. */
  comment?: string | null;
  /** Absolute link to pay the order; only shown for an approved order. */
  paymentUrl?: string | null;
}

export default defineTemplate<CommerceApprovalDecidedEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldCommerce' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).commerce.approvalDecided;
    return fill(props.approved ? t.subjectApproved : t.subjectRejected, { order: props.orderNumber });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).commerce.approvalDecided;
    const by = props.decidedBy?.trim();
    const comment = props.comment?.trim();
    const url = props.approved ? props.paymentUrl?.trim() || undefined : undefined;
    const values = { shop: props.shopName, order: props.orderNumber, currency: props.currency, total: props.total };
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(props.approved ? t.previewApproved : t.previewRejected, values)}
        footer={fill(t.footer, { shop: props.shopName })}
      >
        <Kicker>{props.approved ? t.kickerApproved : t.kickerRejected}</Kicker>
        <Heading>{fill(t.heading, { order: props.orderNumber })}</Heading>
        <Paragraph>{fill(props.approved ? t.bodyApproved : t.bodyRejected, values)}</Paragraph>
        {by ? <Paragraph muted>{fill(t.decidedBy, { name: by })}</Paragraph> : null}
        {comment ? (
          <Quote label={t.comment}>
            <MultilineText text={comment} />
          </Quote>
        ) : null}
        {url ? (
          <>
            <Actions>
              <Button accent={accent} href={url}>{t.pay}</Button>
            </Actions>
            <LinkFallback label={emailStrings(locale).layout.linkFallback} href={url} />
          </>
        ) : null}
      </EmailLayout>
    );
  },

  previews: {
    approved: {
      brand: { kind: 'workspace', name: 'Acme Wholesale', accentColor: '#2563eb' },
      props: {
        shopName: 'Acme Wholesale',
        orderNumber: 'ORD-10043',
        currency: 'EUR',
        total: '1250.00',
        approved: true,
        decidedBy: 'Sanne Jansen',
        comment: 'Fine for this project.\nPlease order the rest next week.',
        paymentUrl: 'https://shop.acme.example/pay/ORD-10043',
      },
    },
    approvedMinimal: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        orderNumber: 'ORD-10043',
        currency: 'EUR',
        total: '1250.00',
        approved: true,
      },
    },
    rejected: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        orderNumber: 'ORD-10043',
        currency: 'EUR',
        total: '1250.00',
        approved: false,
        decidedBy: 'Sanne Jansen',
        comment: 'This is over budget. Order the smaller set.',
      },
    },
    rejectedMinimal: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        orderNumber: 'ORD-10043',
        currency: 'EUR',
        total: '1250.00',
        approved: false,
      },
    },
  },
});
