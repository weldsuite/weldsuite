/**
 * Plan billing on the EU edition (ADR BILL-014): a charge for the
 * workspace's plan failed. Sent to the billing owners (the billing email and
 * the organization admins) by the Rust backend, in three steps:
 *
 * - `failed`: the charge failed; pay with the link before the plan ends.
 * - `reminder`: halfway through the grace period, still unpaid.
 * - `ended`: the grace period ran out and the workspace is on Free.
 *
 * Global's plan emails come from Stripe, so no worker sends this one.
 */

import { accentOf } from '../../brand';
import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill } from '../../i18n';

export type BillingDunningKind = 'failed' | 'reminder' | 'ended';

export interface BillingDunningEmailProps {
  kind: BillingDunningKind;
  workspaceName: string;
  planName: string;
  /** The open amount, formatted by the sender (`€ 123,45`). */
  amount: string;
  /** When the plan ends if unpaid, formatted by the sender (`28 november 2026`). */
  endsOn: string;
  /** The pay link (`failed`, `reminder`) or the billing page (`ended`). */
  url: string;
}

export default defineTemplate<BillingDunningEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) => {
    const t = emailStrings(locale).billingDunning;
    return fill(t[props.kind].subject, { workspace: props.workspaceName, plan: props.planName });
  },

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).billingDunning;
    const copy = t[props.kind];
    const values = {
      workspace: props.workspaceName,
      plan: props.planName,
      amount: props.amount,
      date: props.endsOn,
    };
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(copy.preview, values)}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{fill(copy.heading, values)}</Heading>
        <Paragraph>{fill(copy.body, values)}</Paragraph>
        {props.kind === 'ended' ? null : (
          <Details
            rows={[
              { label: t.workspace, value: props.workspaceName },
              { label: t.plan, value: props.planName },
              { label: t.amount, value: props.amount },
              { label: t.endsOn, value: props.endsOn },
            ]}
          />
        )}
        <Paragraph muted>{copy.note}</Paragraph>
        <Actions>
          <Button accent={accentOf(brand)} href={props.url}>{copy.button}</Button>
        </Actions>
        <LinkFallback label={emailStrings(locale).layout.linkFallback} href={props.url} />
      </EmailLayout>
    );
  },

  previews: {
    failed: {
      props: {
        kind: 'failed',
        workspaceName: 'Acme Studio',
        planName: 'Business',
        amount: '€ 90,75',
        endsOn: '28 november 2026',
        url: 'https://app.weldsuite.eu/public/billing/pay/token',
      },
    },
    reminder: {
      props: {
        kind: 'reminder',
        workspaceName: 'Acme Studio',
        planName: 'Business',
        amount: '€ 90,75',
        endsOn: '28 november 2026',
        url: 'https://app.weldsuite.eu/public/billing/pay/token',
      },
    },
    ended: {
      props: {
        kind: 'ended',
        workspaceName: 'Acme Studio',
        planName: 'Business',
        amount: '€ 90,75',
        endsOn: '28 november 2026',
        url: 'https://app.weldsuite.eu/settings/billing',
      },
    },
  },
});
