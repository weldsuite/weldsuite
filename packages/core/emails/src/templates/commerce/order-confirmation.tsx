/**
 * WeldCommerce: the buyer's copy of an order. Amounts arrive formatted as
 * plain decimal strings ("19.99") and are shown with the currency code.
 * A B2B order can wait for approval from a colleague, or be paid on invoice.
 */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export interface CommerceOrderConfirmationEmailProps {
  shopName: string;
  orderNumber: string;
  currency: string;
  lines: Array<{ name: string; quantity: number; total: string }>;
  subtotal: string;
  shippingTotal: string;
  taxTotal: string;
  total: string;
  /** Absolute link to the order. Absent: no link. */
  orderUrl?: string | null;
  /** The order waits for approval from a colleague at the buyer's company. */
  awaitingApproval?: boolean;
  /** The buyer pays on invoice. */
  onInvoice?: boolean;
}

export default defineTemplate<CommerceOrderConfirmationEmailProps>({
  defaultBrand: { kind: 'weldsuite', module: 'WeldCommerce' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).commerce.orderConfirmation.subject, { shop: props.shopName, order: props.orderNumber }),

  Component: (props) => {
    const { locale, brand } = props;
    const accent = accentOf(brand);
    const t = emailStrings(locale).commerce.orderConfirmation;
    const url = props.orderUrl?.trim() || undefined;
    const money = (amount: string) => fill(t.amount, { currency: props.currency, amount });
    return (
      <EmailLayout
        brand={brand}
        locale={locale}
        preview={fill(t.preview, { shop: props.shopName, order: props.orderNumber })}
        footer={fill(t.footer, { shop: props.shopName })}
      >
        <Kicker>{t.kicker}</Kicker>
        <Heading>{fill(t.heading, { order: props.orderNumber })}</Heading>
        <Paragraph>{fill(t.body, { shop: props.shopName })}</Paragraph>
        {props.awaitingApproval ? <Paragraph>{t.awaitingApproval}</Paragraph> : null}
        {props.onInvoice ? <Paragraph>{t.onInvoice}</Paragraph> : null}
        <Details
          labelWidth={360}
          rows={props.lines.map((line) => ({
            label: fill(t.line, { quantity: line.quantity, name: line.name }),
            value: money(line.total),
          }))}
        />
        <Details
          labelWidth={360}
          rows={[
            { label: t.subtotal, value: money(props.subtotal) },
            { label: t.shipping, value: money(props.shippingTotal) },
            { label: t.tax, value: money(props.taxTotal) },
            { label: t.total, value: money(props.total) },
          ]}
        />
        {url ? (
          <>
            <Actions>
              <Button accent={accent} href={url}>{t.view}</Button>
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
        orderNumber: 'ORD-10042',
        currency: 'EUR',
        lines: [
          { name: 'Safety helmet', quantity: 10, total: '149.90' },
          { name: 'Work gloves, size L', quantity: 24, total: '119.76' },
        ],
        subtotal: '269.66',
        shippingTotal: '9.95',
        taxTotal: '58.88',
        total: '338.49',
        orderUrl: 'https://shop.acme.example/orders/ORD-10042',
        onInvoice: true,
      },
    },
    awaitingApproval: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        orderNumber: 'ORD-10043',
        currency: 'EUR',
        lines: [{ name: 'Safety helmet', quantity: 1, total: '14.99' }],
        subtotal: '14.99',
        shippingTotal: '0.00',
        taxTotal: '3.15',
        total: '18.14',
        orderUrl: 'https://shop.acme.example/orders/ORD-10043',
        awaitingApproval: true,
      },
    },
    minimal: {
      brand: { kind: 'workspace', name: 'Acme Wholesale' },
      props: {
        shopName: 'Acme Wholesale',
        orderNumber: 'ORD-10044',
        currency: 'EUR',
        lines: [{ name: 'Safety helmet', quantity: 1, total: '14.99' }],
        subtotal: '14.99',
        shippingTotal: '0.00',
        taxTotal: '3.15',
        total: '18.14',
      },
    },
  },
});
