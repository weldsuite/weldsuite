/** Billing: an unpaid partner statement reached a dunning stage (day 14 / 23 / 30 past due). */

import { Actions, Button, Details, EmailLayout, Heading, Kicker, Paragraph } from '../../components';
import { accentOf } from '../../brand';
import { defineTemplate } from '../../define';
import { fill, intlLocale, type EmailLocale } from '../../i18n';
import { partnerStrings } from './copy';

export type PartnerDunningStage = 'past_due' | 'final_warning' | 'suspended';

export interface PartnerDunningEmailProps {
  stage: PartnerDunningStage;
  partnerName: string;
  /** ISO start of the statement period; shown as a month ("September 2026"). */
  periodStart: string;
  /** Total due as a decimal string ("1234.00"). */
  amountDue: string;
  currency: string;
  /** ISO due date of the Stripe invoice. */
  dueAt: string;
  daysOverdue: number;
  /** ISO date the workspaces go (or went) read-only. */
  readOnlyAt: string;
  /** Stripe hosted invoice page, when there is one. */
  invoiceUrl?: string | null;
  portalUrl?: string | null;
}

const STAGE_KEY = { past_due: 'pastDue', final_warning: 'finalWarning', suspended: 'suspended' } as const;

function month(iso: string, locale: EmailLocale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso));
}

function day(iso: string, locale: EmailLocale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );
}

function money(amount: string, currency: string, locale: EmailLocale): string {
  try {
    return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency }).format(Number(amount));
  } catch {
    return `${amount} ${currency}`;
  }
}

function values(props: PartnerDunningEmailProps, locale: EmailLocale) {
  return {
    period: month(props.periodStart, locale),
    amount: money(props.amountDue, props.currency, locale),
    dueDate: day(props.dueAt, locale),
    readOnlyDate: day(props.readOnlyAt, locale),
    days: props.daysOverdue,
  };
}

export default defineTemplate<PartnerDunningEmailProps>({
  defaultBrand: { kind: 'weldsuite' },

  subject: (props, { locale }) =>
    fill(partnerStrings[locale].dunning[STAGE_KEY[props.stage]].subject, values(props, locale)),

  Component: (props) => {
    const { locale, brand } = props;
    const t = partnerStrings[locale].dunning;
    const copy = t[STAGE_KEY[props.stage]];
    const v = values(props, locale);
    const url = props.invoiceUrl || props.portalUrl || null;
    return (
      <EmailLayout brand={brand} locale={locale} preview={fill(copy.preview, v)}>
        <Kicker>{copy.kicker}</Kicker>
        <Heading>{props.partnerName}</Heading>
        <Paragraph>{fill(copy.body, v)}</Paragraph>
        <Details
          rows={[
            { label: t.statement, value: v.period },
            { label: t.amount, value: v.amount },
            { label: t.dueDate, value: v.dueDate },
            { label: t.overdue, value: fill(t.overdueDays, { days: props.daysOverdue }) },
            { label: t.readOnlyDate, value: props.stage === 'past_due' ? undefined : v.readOnlyDate },
          ]}
        />
        {url ? (
          <Actions>
            <Button accent={accentOf(brand)} href={url}>
              {props.invoiceUrl ? t.payInvoice : t.openPortal}
            </Button>
          </Actions>
        ) : null}
        <Paragraph muted>{t.alreadyPaid}</Paragraph>
      </EmailLayout>
    );
  },

  previews: {
    pastDue: {
      props: {
        stage: 'past_due',
        partnerName: 'Andes Cloud SAS',
        periodStart: '2026-09-01T00:00:00.000Z',
        amountDue: '1842.50',
        currency: 'USD',
        dueAt: '2026-10-31T00:00:00.000Z',
        daysOverdue: 14,
        readOnlyAt: '2026-11-30T00:00:00.000Z',
        invoiceUrl: 'https://invoice.stripe.com/i/acct_1/test_abc',
      },
    },
    finalWarning: {
      props: {
        stage: 'final_warning',
        partnerName: 'Andes Cloud SAS',
        periodStart: '2026-09-01T00:00:00.000Z',
        amountDue: '1842.50',
        currency: 'USD',
        dueAt: '2026-10-31T00:00:00.000Z',
        daysOverdue: 23,
        readOnlyAt: '2026-11-30T00:00:00.000Z',
        invoiceUrl: 'https://invoice.stripe.com/i/acct_1/test_abc',
      },
    },
    suspendedNoInvoiceLink: {
      props: {
        stage: 'suspended',
        partnerName: 'Andes Cloud SAS',
        periodStart: '2026-09-01T00:00:00.000Z',
        amountDue: '1842.50',
        currency: 'USD',
        dueAt: '2026-10-31T00:00:00.000Z',
        daysOverdue: 30,
        readOnlyAt: '2026-11-30T00:00:00.000Z',
        portalUrl: 'https://app.weldsuite.org/partner/statements',
      },
    },
  },
});
