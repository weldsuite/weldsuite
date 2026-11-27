/**
 * Customer-facing copy, en + nl, as in sign-portal. The language is the
 * document's `locale` (the sender's choice for this customer) once it is
 * loaded; before that, and for a link that does not work, the browser's
 * Accept-Language decides.
 *
 * Dutch uses the informal "je", as the other portals do.
 */

import type { Locale } from './contract'

export type { Locale }
export const DEFAULT_LOCALE: Locale = 'en'

const en = {
  metaDescription: 'View, download and pay your invoice, or accept your quote.',
  home: {
    title: 'Invoices and quotes',
    body: 'Open the link in the email you received to view your invoice or quote, download it and pay or accept it online.',
  },
  invalid: {
    title: 'This link is no longer valid',
    body: 'This link is no longer valid. Ask the sender for a new one.',
  },
  error: {
    title: 'Something went wrong',
    body: 'We could not load this page. Check your connection and try again.',
    retry: 'Try again',
  },
  kind: { invoice: 'Invoice', quote: 'Quote' },
  from: 'From',
  billTo: 'Bill to',
  quoteFor: 'Prepared for',
  issueDate: 'Issue date',
  dueDate: 'Due date',
  validUntil: 'Valid until',
  lines: {
    caption: 'Lines',
    description: 'Description',
    quantity: 'Qty',
    unitPrice: 'Unit price',
    vat: 'VAT',
    total: 'Total',
  },
  totals: {
    subtotal: 'Subtotal',
    vatAt: (rate: string) => `VAT ${rate}%`,
    total: 'Total',
    paid: 'Paid',
    balanceDue: 'Balance due',
  },
  notes: 'Notes',
  paymentTerms: 'Payment terms',
  details: {
    title: 'Pay by bank transfer',
    iban: 'IBAN',
    bic: 'BIC',
    reference: 'Reference',
    vatNumber: 'VAT number',
    registrationNumber: 'Chamber of Commerce',
    email: 'Email',
    phone: 'Phone',
  },
  status: {
    paid: { title: 'Paid', body: 'This invoice has been paid. Thank you.' },
    partiallyPaid: (balance: string) => ({ title: 'Partly paid', body: `A balance of ${balance} is still open.` }),
    overdue: (date: string) => ({ title: 'Overdue', body: `This invoice was due on ${date}. Please pay it as soon as you can.` }),
    cancelled: { title: 'Cancelled', body: 'This document was cancelled. There is nothing to pay.' },
    pending: { title: 'Payment pending', body: 'Your payment is being processed. This can take a moment.' },
    accepted: { title: 'Accepted', body: 'This quote has been accepted.' },
    declined: { title: 'Declined', body: 'This quote was declined.' },
    expired: (date: string | null) => ({
      title: 'Expired',
      body: date ? `This quote was valid until ${date} and can no longer be accepted.` : 'This quote has expired and can no longer be accepted.',
    }),
  },
  actions: {
    downloadPdf: 'Download PDF',
    payNow: (amount: string) => `Pay now ${amount}`,
    paying: 'Opening the payment page',
    printPage: 'Print',
  },
  pay: {
    methods: 'Pay online with iDEAL, Bancontact, card or another method.',
    conflict: 'There is nothing left to pay on this document. Reload the page to see its latest state.',
    unavailable: 'Online payment is not available right now. You can pay by bank transfer with the details below.',
    rateLimited: 'Too many attempts. Wait a minute and try again.',
    notFound: 'This link is no longer valid. Ask the sender for a new one.',
    generic: 'We could not start the payment. Please try again.',
  },
  accept: {
    title: 'Accept this quote',
    intro: 'Enter your name and email address to accept this quote.',
    name: 'Full name',
    email: 'Email address',
    emailHint: 'Format: you@example.com',
    agree: 'I accept this quote and its terms',
    submit: 'Accept quote',
    submitting: 'Accepting',
    nameRequired: 'Enter your full name.',
    emailInvalid: 'Enter an email address in the format you@example.com.',
    agreeRequired: 'Tick the box to accept the quote.',
    errorPrefix: 'Error',
    conflict: 'This quote can no longer be accepted. Reload the page to see its latest state.',
    rateLimited: 'Too many attempts. Wait a minute and try again.',
    notFound: 'This link is no longer valid. Ask the sender for a new one.',
    generic: 'We could not save your answer. Please try again.',
    doneTitle: 'Quote accepted',
    doneBody: (name: string, when: string) => `Accepted by ${name} on ${when}.`,
    thanks: 'Thank you. The sender has been told.',
  },
  return: {
    title: 'Payment',
    received: { title: 'Payment received', body: 'Thank you. Your payment has been received.' },
    pending: { title: 'Payment pending', body: 'Your payment has not been confirmed yet. This can take a moment: check again in a minute.' },
    notCompleted: { title: 'Payment not completed', body: 'The payment was not completed, and nothing was charged. You can try again.' },
    tryAgain: 'Try again',
    refresh: 'Check again',
    back: 'Back to the document',
  },
  language: 'English',
}

export type Dictionary = typeof en

const nl: Dictionary = {
  metaDescription: 'Bekijk, download en betaal je factuur, of accepteer je offerte.',
  home: {
    title: 'Facturen en offertes',
    body: 'Open de link in de e-mail die je hebt ontvangen om je factuur of offerte te bekijken, te downloaden en online te betalen of te accepteren.',
  },
  invalid: {
    title: 'Deze link is niet meer geldig',
    body: 'Deze link is niet meer geldig. Vraag de afzender om een nieuwe.',
  },
  error: {
    title: 'Er ging iets mis',
    body: 'We konden deze pagina niet laden. Controleer je verbinding en probeer het opnieuw.',
    retry: 'Opnieuw proberen',
  },
  kind: { invoice: 'Factuur', quote: 'Offerte' },
  from: 'Van',
  billTo: 'Factuur aan',
  quoteFor: 'Opgesteld voor',
  issueDate: 'Datum',
  dueDate: 'Vervaldatum',
  validUntil: 'Geldig tot',
  lines: {
    caption: 'Regels',
    description: 'Omschrijving',
    quantity: 'Aantal',
    unitPrice: 'Prijs per stuk',
    vat: 'Btw',
    total: 'Totaal',
  },
  totals: {
    subtotal: 'Subtotaal',
    vatAt: (rate: string) => `Btw ${rate}%`,
    total: 'Totaal',
    paid: 'Betaald',
    balanceDue: 'Openstaand bedrag',
  },
  notes: 'Opmerkingen',
  paymentTerms: 'Betalingsvoorwaarden',
  details: {
    title: 'Betalen per bankoverschrijving',
    iban: 'IBAN',
    bic: 'BIC',
    reference: 'Kenmerk',
    vatNumber: 'Btw-nummer',
    registrationNumber: 'KvK-nummer',
    email: 'E-mail',
    phone: 'Telefoon',
  },
  status: {
    paid: { title: 'Betaald', body: 'Deze factuur is betaald. Bedankt.' },
    partiallyPaid: (balance: string) => ({ title: 'Gedeeltelijk betaald', body: `Er staat nog ${balance} open.` }),
    overdue: (date: string) => ({ title: 'Verlopen', body: `Deze factuur had betaald moeten zijn op ${date}. Betaal hem alsjeblieft zo snel mogelijk.` }),
    cancelled: { title: 'Geannuleerd', body: 'Dit document is geannuleerd. Er hoeft niets betaald te worden.' },
    pending: { title: 'Betaling in behandeling', body: 'Je betaling wordt verwerkt. Dit kan even duren.' },
    accepted: { title: 'Geaccepteerd', body: 'Deze offerte is geaccepteerd.' },
    declined: { title: 'Afgewezen', body: 'Deze offerte is afgewezen.' },
    expired: (date: string | null) => ({
      title: 'Verlopen',
      body: date ? `Deze offerte was geldig tot ${date} en kan niet meer worden geaccepteerd.` : 'Deze offerte is verlopen en kan niet meer worden geaccepteerd.',
    }),
  },
  actions: {
    downloadPdf: 'PDF downloaden',
    payNow: (amount: string) => `Nu betalen ${amount}`,
    paying: 'De betaalpagina wordt geopend',
    printPage: 'Afdrukken',
  },
  pay: {
    methods: 'Betaal online met iDEAL, Bancontact, creditcard of een andere methode.',
    conflict: 'Er valt niets meer te betalen op dit document. Laad de pagina opnieuw voor de laatste stand.',
    unavailable: 'Online betalen is nu niet beschikbaar. Je kunt betalen per bankoverschrijving met de gegevens hieronder.',
    rateLimited: 'Te veel pogingen. Wacht een minuut en probeer het opnieuw.',
    notFound: 'Deze link is niet meer geldig. Vraag de afzender om een nieuwe.',
    generic: 'We konden de betaling niet starten. Probeer het opnieuw.',
  },
  accept: {
    title: 'Deze offerte accepteren',
    intro: 'Vul je naam en e-mailadres in om deze offerte te accepteren.',
    name: 'Volledige naam',
    email: 'E-mailadres',
    emailHint: 'Formaat: jij@voorbeeld.nl',
    agree: 'Ik accepteer deze offerte en de voorwaarden',
    submit: 'Offerte accepteren',
    submitting: 'Accepteren',
    nameRequired: 'Vul je volledige naam in.',
    emailInvalid: 'Vul een e-mailadres in zoals jij@voorbeeld.nl.',
    agreeRequired: 'Vink het vakje aan om de offerte te accepteren.',
    errorPrefix: 'Fout',
    conflict: 'Deze offerte kan niet meer worden geaccepteerd. Laad de pagina opnieuw voor de laatste stand.',
    rateLimited: 'Te veel pogingen. Wacht een minuut en probeer het opnieuw.',
    notFound: 'Deze link is niet meer geldig. Vraag de afzender om een nieuwe.',
    generic: 'We konden je antwoord niet opslaan. Probeer het opnieuw.',
    doneTitle: 'Offerte geaccepteerd',
    doneBody: (name: string, when: string) => `Geaccepteerd door ${name} op ${when}.`,
    thanks: 'Bedankt. De afzender is op de hoogte gebracht.',
  },
  return: {
    title: 'Betaling',
    received: { title: 'Betaling ontvangen', body: 'Bedankt. We hebben je betaling ontvangen.' },
    pending: { title: 'Betaling in behandeling', body: 'Je betaling is nog niet bevestigd. Dit kan even duren: kijk over een minuut opnieuw.' },
    notCompleted: { title: 'Betaling niet voltooid', body: 'De betaling is niet voltooid en er is niets afgeschreven. Je kunt het opnieuw proberen.' },
    tryAgain: 'Opnieuw proberen',
    refresh: 'Opnieuw controleren',
    back: 'Terug naar het document',
  },
  language: 'Nederlands',
}

export const dictionaries: Record<Locale, Dictionary> = { en, nl }

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'nl'
}

/** First supported locale in an `Accept-Language` header, else null. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null
  for (const part of header.split(',')) {
    const lang = part.split(';')[0]?.trim().toLowerCase().split('-')[0]
    if (lang === 'en' || lang === 'nl') return lang
  }
  return null
}

/** The language a route's loader data carries: a bare locale (the root's) or an object with one (a document's). */
export function localeOfLoaderData(data: unknown): Locale | null {
  if (isLocale(data)) return data
  if (data && typeof data === 'object' && 'locale' in data && isLocale(data.locale)) return data.locale
  return null
}

/** The document's language wins; the browser's decides when there is no document. */
export function chooseLocale(documentLocale: Locale | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(documentLocale)) return documentLocale
  return localeFromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE
}
