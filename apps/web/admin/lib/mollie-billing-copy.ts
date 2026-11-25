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
  seatPriceNote: {
    below: 'Custom price, {percent} below the list price of {list}',
    above: 'Custom price, {percent} above the list price of {list}',
    free: 'Free seats, instead of the list price of {list}',
  },
  adjustSeatPrice: 'Adjust seat price',
  seatPriceDialog: {
    title: 'Adjust seat price',
    description: 'What this workspace pays per seat for {plan} instead of the list price, from its next charge on.',
    current: 'Current price',
    listPrice: 'List price',
    perSeat: '{amount} per seat per {interval}',
    amount: 'New price per seat per {interval} (EUR, excl. VAT)',
    amountPlaceholder: '20.00',
    useList: 'Use list price',
    total: '{seats} × {amount} = {total} per {interval}, excl. VAT',
    when: 'The renewal on {date} charges the new price. Nothing is charged or refunded for the current period, and seats added before then are charged at the new price.',
    ends: 'The price stays until the customer changes plan or billing cycle; a new plan is charged at its list price.',
    scheduled: 'A change of plan or billing cycle is scheduled for {date}, so this price only applies until then.',
    free: 'At zero the seats are free: renewals charge nothing for them. Add-ons such as WeldReach inboxes are still charged, and the plan’s credits still come.',
    submit: 'Save seat price',
    success: 'Seat price saved.',
    errors: {
      format: 'Enter an amount such as 20, 19.50 or 0.',
      tooHigh: 'A seat can cost at most {max}.',
      unchanged: 'That is already the seat price.',
      noSubscription: 'This workspace has no running subscription on Mollie, so it has no seat price to change.',
      notEur: 'This workspace is billed in {currency}; seat prices are set in EUR only.',
      notFound: 'Workspace not found.',
    },
  },
  /** Labels for this card's entries in the workspace's activity log. */
  activity: {
    'workspace.billing.seat_price': 'Seat price changed',
  } as Record<string, string>,
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
    intro: 'Other changes run from the CLI, not from this console. Each command runs in the server pod:',
    show: 'plan, seats, the Mollie account and the latest charges',
    comp: 'a complimentary plan: nothing is charged, the plan’s credits still come',
    uncomp: 'ends the comp now',
    refund: 'refunds a paid charge through Mollie; make the credit note in WeldBooks',
    retryNow: 'charges the open charge of a past-due workspace on its mandate again',
  },
  /** The one-line hint where the Stripe actions would be. */
  readOnlyHint:
    'On this edition the seat price is adjusted on the Mollie billing card; other billing changes run from the CLI (weldsuite admin billing comp, uncomp, refund or retry-now).',
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
  seatPriceNote: {
    below: 'Aangepaste prijs, {percent} onder de lijstprijs van {list}',
    above: 'Aangepaste prijs, {percent} boven de lijstprijs van {list}',
    free: 'Gratis gebruikers, in plaats van de lijstprijs van {list}',
  },
  adjustSeatPrice: 'Prijs per gebruiker aanpassen',
  seatPriceDialog: {
    title: 'Prijs per gebruiker aanpassen',
    description: 'Wat deze werkruimte per gebruiker betaalt voor {plan} in plaats van de lijstprijs, vanaf de volgende afschrijving.',
    current: 'Huidige prijs',
    listPrice: 'Lijstprijs',
    perSeat: '{amount} per gebruiker per {interval}',
    amount: 'Nieuwe prijs per gebruiker per {interval} (EUR, excl. btw)',
    amountPlaceholder: '20,00',
    useList: 'Lijstprijs gebruiken',
    total: '{seats} × {amount} = {total} per {interval}, excl. btw',
    when: 'De verlenging op {date} schrijft de nieuwe prijs af. Voor de huidige periode wordt niets afgeschreven of terugbetaald, en gebruikers die tot dan worden toegevoegd, kosten de nieuwe prijs.',
    ends: 'De prijs blijft tot de klant van plan of factuurcyclus wisselt; een nieuw plan kost de lijstprijs.',
    scheduled: 'Op {date} staat een wijziging van plan of factuurcyclus gepland, dus deze prijs geldt alleen tot dan.',
    free: 'Bij nul zijn de gebruikers gratis: verlengingen schrijven er niets voor af. Add-ons zoals WeldReach-inboxen worden wel afgeschreven, en de credits van het plan komen gewoon.',
    submit: 'Prijs opslaan',
    success: 'Prijs per gebruiker opgeslagen.',
    errors: {
      format: 'Vul een bedrag in zoals 20, 19,50 of 0.',
      tooHigh: 'Een gebruiker kost hoogstens {max}.',
      unchanged: 'Dat is al de prijs per gebruiker.',
      noSubscription: 'Deze werkruimte heeft geen lopend abonnement bij Mollie, dus er is geen prijs per gebruiker om te wijzigen.',
      notEur: 'Deze werkruimte wordt gefactureerd in {currency}; prijzen per gebruiker gaan alleen in EUR.',
      notFound: 'Werkruimte niet gevonden.',
    },
  },
  activity: {
    'workspace.billing.seat_price': 'Prijs per gebruiker gewijzigd',
  },
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
    intro: 'Andere wijzigingen lopen via de CLI, niet via deze console. Elke opdracht draait in de serverpod:',
    show: 'plan, gebruikers, het Mollie-account en de laatste betalingen',
    comp: 'een gratis plan: er wordt niets afgeschreven, de credits van het plan komen wel',
    uncomp: 'beëindigt het gratis plan nu',
    refund: 'betaalt een betaalde afschrijving via Mollie terug; maak de creditnota in WeldBooks',
    retryNow: 'schrijft de openstaande betaling van een achterstallige werkruimte opnieuw af via het mandaat',
  },
  readOnlyHint:
    'In deze editie pas je de prijs per gebruiker aan op de Mollie-factureringskaart; andere factuurwijzigingen lopen via de CLI (weldsuite admin billing comp, uncomp, refund of retry-now).',
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

/** An activity log label for a Mollie billing action, or null when it isn't one. */
export function mollieActionLabel(action: string): string | null {
  return mollieBillingCopy().activity[action] ?? null;
}
