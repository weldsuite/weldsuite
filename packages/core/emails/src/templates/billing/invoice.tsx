/**
 * Plan billing on the EU edition (ADR BILL-014, decision 5): the WeldBooks
 * invoice of a paid charge (a checkout, a renewal, a plan or seat change, a
 * WeldReach inbox, a credit top-up). Sent once per invoice to the billing
 * owners (the billing email and the organization admins) by the Rust
 * backend, right after the invoice is issued. The invoice itself opens in
 * Settings › Billing; the email carries no attachment, since the printable
 * invoice is HTML that only a signed-in member may open.
 *
 * The VAT line follows the charge's treatment:
 *
 * - `charged`: VAT at a rate, the seller's (domestic) or the customer
 *   country's (OSS).
 * - `reverse`: an EU business elsewhere; the customer accounts for the VAT.
 * - `outside`: a customer outside the EU; no EU VAT.
 *
 * Global's invoices come from Stripe, so no worker sends this one.
 */

import { accentOf } from '../../brand';
import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export type BillingInvoiceVat = 'charged' | 'reverse' | 'outside';

export interface BillingInvoiceEmailProps {
  workspaceName: string;
  /** The invoice number (`INV-0001`). */
  number: string;
  /** The invoice date, formatted by the sender (`19 november 2026`). */
  date: string;
  /** What was paid, VAT included, formatted by the sender (`€ 90,75`). */
  amount: string;
  vat: BillingInvoiceVat;
  /** The VAT on it, formatted by the sender (`€ 15,75`); `charged` only. */
  vatAmount: string;
  /** Its rate without the sign, formatted by the sender (`21`, `25,5`); `charged` only. */
  vatRate: string;
  /** Settings › Billing, where the invoice opens. */
  url: string;
}

export default defineTemplate<BillingInvoiceEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(emailStrings(locale).billingInvoice.subject, { number: props.number, workspace: props.workspaceName }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).billingInvoice;
    const values = { number: props.number, workspace: props.workspaceName, amount: props.amount };
    const vat =
      props.vat === 'charged'
        ? fill(t.vatCharged, { amount: props.vatAmount, rate: props.vatRate })
        : props.vat === 'reverse'
          ? t.vatReverse
          : t.vatOutside;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(t.preview, values)}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{fill(t.heading, values)}</Heading>
        <Paragraph>{fill(t.body, values)}</Paragraph>
        <Details
          rows={[
            { label: t.workspace, value: props.workspaceName },
            { label: t.number, value: props.number },
            { label: t.date, value: props.date },
            { label: props.vat === 'charged' ? t.amountInclVat : t.amount, value: props.amount },
            { label: t.vat, value: vat },
          ]}
        />
        {props.vat === 'reverse' ? <Paragraph muted>{t.reverseNote}</Paragraph> : null}
        <Paragraph muted>{t.note}</Paragraph>
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>{t.button}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.url} />
      </EmailLayout>
    );
  },

  previews: {
    charged: {
      props: {
        workspaceName: 'Acme Studio',
        number: 'INV-0042',
        date: '19 november 2026',
        amount: '€ 90,75',
        vat: 'charged',
        vatAmount: '€ 15,75',
        vatRate: '21',
        url: 'https://app.weldsuite.eu/settings/billing',
      },
    },
    reverse: {
      props: {
        workspaceName: 'Acme GmbH',
        number: 'INV-0043',
        date: '19 november 2026',
        amount: '€ 75,00',
        vat: 'reverse',
        vatAmount: '€ 0,00',
        vatRate: '0',
        url: 'https://app.weldsuite.eu/settings/billing',
      },
    },
    outside: {
      props: {
        workspaceName: 'Acme Corp',
        number: 'INV-0044',
        date: '19 november 2026',
        amount: '€ 75,00',
        vat: 'outside',
        vatAmount: '€ 0,00',
        vatRate: '0',
        url: 'https://app.weldsuite.eu/settings/billing',
      },
    },
  },
});
