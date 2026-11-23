/**
 * Plan billing on the EU edition (ADR BILL-014): a charge for the
 * workspace's plan failed. Sent to the billing owners (the billing email and
 * the organization admins) by the Rust backend, in three steps:
 *
 * - `failed`: the charge failed; pay with the link before the plan ends.
 * - `reminder`: halfway through the grace period, still unpaid.
 * - `ended`: the grace period ran out and the workspace is on Free.
 *
 * And one before them: `upcoming`, the plan renews soon and there is no
 * payment method to charge (every workspace that moved from Global arrives
 * without one): add one before the renewal. When the renewal was refused for
 * want of one, `noMethod` makes `failed` and `reminder` ask for a payment
 * method instead of saying a payment was refused.
 *
 * Global's plan emails come from Stripe, so no worker sends this one.
 */

import { accentOf } from '../../brand';
import { Actions, Button, Details, EmailLayout, Heading, Kicker, LinkFallback, Paragraph } from '../../components';
import { defineTemplate } from '../../define';
import { emailStrings, fill, type EmailLocale } from '../../i18n';

export type BillingDunningKind = 'failed' | 'reminder' | 'ended' | 'upcoming';

export interface BillingDunningEmailProps {
  kind: BillingDunningKind;
  workspaceName: string;
  planName: string;
  /** The open amount, formatted by the sender (`€ 123,45`). */
  amount: string;
  /**
   * When the plan ends if unpaid, formatted by the sender (`28 november 2026`);
   * for `upcoming`, the renewal.
   */
  endsOn: string;
  /** The pay link (`failed`, `reminder`) or the billing page (`ended`, `upcoming`). */
  url: string;
  /** No payment method on file: `failed` and `reminder` ask for one. */
  noMethod?: boolean;
}

/** The copy of one email: `noMethod` changes only a failed charge and its reminder. */
function copyOf(locale: EmailLocale, props: Pick<BillingDunningEmailProps, 'kind' | 'noMethod'>) {
  const t = emailStrings(locale).billingDunning;
  if (props.noMethod && props.kind === 'failed') return t.failedNoMethod;
  if (props.noMethod && props.kind === 'reminder') return t.reminderNoMethod;
  return t[props.kind];
}

export default defineTemplate<BillingDunningEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(copyOf(locale, props).subject, {
      workspace: props.workspaceName,
      plan: props.planName,
      date: props.endsOn,
    }),

  Component: (props) => {
    const { locale, brand } = props;
    const t = emailStrings(locale).billingDunning;
    const copy = copyOf(locale, props);
    const values = {
      workspace: props.workspaceName,
      plan: props.planName,
      amount: props.amount,
      date: props.endsOn,
    };
    const rows =
      props.kind === 'upcoming'
        ? [
            { label: t.workspace, value: props.workspaceName },
            { label: t.plan, value: props.planName },
            { label: t.renewsOn, value: props.endsOn },
          ]
        : [
            { label: t.workspace, value: props.workspaceName },
            { label: t.plan, value: props.planName },
            { label: t.amount, value: props.amount },
            { label: t.endsOn, value: props.endsOn },
          ];
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(copy.preview, values)}>
        <Kicker>{t.kicker}</Kicker>
        <Heading>{fill(copy.heading, values)}</Heading>
        <Paragraph>{fill(copy.body, values)}</Paragraph>
        {props.kind === 'ended' ? null : <Details rows={rows} />}
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
    upcoming: {
      props: {
        kind: 'upcoming',
        workspaceName: 'Acme Studio',
        planName: 'Business',
        amount: '',
        endsOn: '14 december 2026',
        url: 'https://app.weldsuite.eu/settings/billing',
        noMethod: true,
      },
    },
    failedNoMethod: {
      props: {
        kind: 'failed',
        workspaceName: 'Acme Studio',
        planName: 'Business',
        amount: '€ 90,75',
        endsOn: '28 december 2026',
        url: 'https://app.weldsuite.eu/public/billing/pay/token',
        noMethod: true,
      },
    },
    reminderNoMethod: {
      props: {
        kind: 'reminder',
        workspaceName: 'Acme Studio',
        planName: 'Business',
        amount: '€ 90,75',
        endsOn: '28 december 2026',
        url: 'https://app.weldsuite.eu/public/billing/pay/token',
        noMethod: true,
      },
    },
  },
});
