import { getLocale } from '@weldsuite/i18n';

/**
 * Copy for plan billing on Mollie (the Kubernetes editions, ADR BILL-014) on
 * the workspace billing tab, en + nl. Like ./sso-copy.ts it lives with the
 * console rather than in the `admin` namespace of @weldsuite/i18n only because
 * that package was owned by another workstream while this was built; move it
 * there when convenient (same shape: nested objects, `{placeholder}` filled by
 * `fill()` from ./i18n).
 */

const en = {
  title: 'Mollie billing',
  pastDueBadge: 'Past due',
  none: 'None',
  rows: {
    customer: 'Mollie customer',
    paymentMethod: 'Default payment method',
    seatPrice: 'Seat price',
    nextCharge: 'Next charge',
    billingDay: 'Billing day',
  },
  seatPrice: '{amount} per seat per {interval}, excl. VAT',
  intervalMonth: 'month',
  intervalYear: 'year',
  billingDay: 'Day {day} of the month',
  methods: {
    creditcard: 'Card',
    directdebit: 'SEPA Direct Debit',
    paypal: 'PayPal',
  },
  scheduled: {
    title: 'At the end of the period ({date})',
    plan: 'Plan',
    seats: 'Seats',
    cycle: 'Cycle',
    monthly: 'Monthly',
    yearly: 'Yearly',
  },
  pastDue: {
    since: 'Past due since {date}.',
    charge: 'Open charge {id}: {amount} ({status}).',
    noCharge: 'The open charge is not recorded.',
    failure: 'Last failure: {message}',
    reminded: 'Billing owners last reminded on {date}.',
  },
  cli: {
    intro: 'Changes run from the CLI, not from this console. Each command runs in the server pod:',
    show: 'plan, seats, the Mollie account and the latest charges',
    comp: 'a complimentary plan: nothing is charged, the plan’s credits still come',
    uncomp: 'ends the comp now',
    refund: 'refunds a paid charge through Mollie; make the credit note in WeldBooks',
    retryNow: 'charges the open charge of a past-due workspace on its mandate again',
  },
  /** The one-line hint where the Stripe actions would be. */
  readOnlyHint:
    'On this edition billing changes run from the CLI (weldsuite admin billing comp, uncomp, refund or retry-now), not from this console.',
  history: {
    mollie: 'Mollie',
    weldbooks: 'WeldBooks',
    refundHint: 'Refund a Mollie charge from the CLI: weldsuite admin billing refund <bpy_…|tr_…> --as <email> --reason <text>.',
    kinds: {
      checkout: 'Checkout',
      change: 'Plan change',
      renewal: 'Renewal',
      pay_link: 'Payment link',
      mandate: 'Mandate check',
      credits: 'Credit top-up',
      addon: 'WeldReach inbox',
    },
  },
};

export type MollieBillingCopy = typeof en;

const nl: MollieBillingCopy = {
  title: 'Mollie-facturering',
  pastDueBadge: 'Achterstallig',
  none: 'Geen',
  rows: {
    customer: 'Mollie-klant',
    paymentMethod: 'Standaardbetaalmethode',
    seatPrice: 'Prijs per gebruiker',
    nextCharge: 'Volgende afschrijving',
    billingDay: 'Factuurdag',
  },
  seatPrice: '{amount} per gebruiker per {interval}, excl. btw',
  intervalMonth: 'maand',
  intervalYear: 'jaar',
  billingDay: 'Dag {day} van de maand',
  methods: {
    creditcard: 'Kaart',
    directdebit: 'SEPA-incasso',
    paypal: 'PayPal',
  },
  scheduled: {
    title: 'Aan het einde van de periode ({date})',
    plan: 'Plan',
    seats: 'Gebruikers',
    cycle: 'Cyclus',
    monthly: 'Maandelijks',
    yearly: 'Jaarlijks',
  },
  pastDue: {
    since: 'Achterstallig sinds {date}.',
    charge: 'Openstaande betaling {id}: {amount} ({status}).',
    noCharge: 'De openstaande betaling is niet vastgelegd.',
    failure: 'Laatste fout: {message}',
    reminded: 'Factuurbeheerders laatst herinnerd op {date}.',
  },
  cli: {
    intro: 'Wijzigingen lopen via de CLI, niet via deze console. Elke opdracht draait in de serverpod:',
    show: 'plan, gebruikers, het Mollie-account en de laatste betalingen',
    comp: 'een gratis plan: er wordt niets afgeschreven, de credits van het plan komen wel',
    uncomp: 'beëindigt het gratis plan nu',
    refund: 'betaalt een betaalde afschrijving via Mollie terug; maak de creditnota in WeldBooks',
    retryNow: 'schrijft de openstaande betaling van een achterstallige werkruimte opnieuw af via het mandaat',
  },
  readOnlyHint:
    'In deze editie lopen factuurwijzigingen via de CLI (weldsuite admin billing comp, uncomp, refund of retry-now), niet via deze console.',
  history: {
    mollie: 'Mollie',
    weldbooks: 'WeldBooks',
    refundHint: 'Betaal een Mollie-afschrijving terug via de CLI: weldsuite admin billing refund <bpy_…|tr_…> --as <email> --reason <text>.',
    kinds: {
      checkout: 'Afrekenen',
      change: 'Planwijziging',
      renewal: 'Verlenging',
      pay_link: 'Betaallink',
      mandate: 'Mandaatcontrole',
      credits: 'Credits bijkopen',
      addon: 'WeldReach-inbox',
    },
  },
};

/**
 * Same locale source as the rest of the console (`getLocale()`, the i18n
 * cookie); anything but `nl` reads English.
 */
export function mollieBillingCopy(): MollieBillingCopy {
  return getLocale() === 'nl' ? nl : en;
}

export const mollieBillingCopyByLocale = { en, nl } as const;
