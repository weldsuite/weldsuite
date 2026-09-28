import type { InvoiceLabels, InvoiceRequirements } from '../types';

const nlLabels: InvoiceLabels = {
  invoice: 'Factuur',
  creditNote: 'Creditnota',
  invoiceNumber: 'Factuurnummer',
  date: 'Datum',
  dueDate: 'Vervaldatum',
  billTo: 'Factureren aan',
  description: 'Omschrijving',
  quantity: 'Aantal',
  unitPrice: 'Prijs per stuk',
  tax: 'BTW',
  amount: 'Bedrag',
  subtotal: 'Subtotaal',
  discount: 'Korting',
  taxTotal: 'BTW totaal',
  total: 'Totaal',
  amountPaid: 'Betaald',
  balanceDue: 'Openstaand',
  paymentInstructions: 'Betalingsgegevens',
  vatNumberLabel: 'BTW-nummer',
  registrationLabel: 'KVK',
};

const enLabels: InvoiceLabels = {
  invoice: 'Invoice',
  creditNote: 'Credit note',
  invoiceNumber: 'Invoice number',
  date: 'Date',
  dueDate: 'Due date',
  billTo: 'Bill to',
  description: 'Description',
  quantity: 'Quantity',
  unitPrice: 'Unit price',
  tax: 'VAT',
  amount: 'Amount',
  subtotal: 'Subtotal',
  discount: 'Discount',
  taxTotal: 'VAT total',
  total: 'Total',
  amountPaid: 'Paid',
  balanceDue: 'Balance due',
  paymentInstructions: 'Payment instructions',
  vatNumberLabel: 'VAT number',
  registrationLabel: 'CoC',
};

/**
 * Legally required invoice statements (factuureisen). WeldBooks always issues
 * FULL invoices — the vereenvoudigde factuur (≤ €100 incl. BTW) is an optional
 * relaxation, never a requirement, and it may not be used for intracommunautaire
 * leveringen anyway, so we deliberately don't implement it.
 */
export const NL_NOTICE_REVERSE_CHARGE_DOMESTIC = 'BTW verlegd';
export const NL_NOTICE_REVERSE_CHARGE_EU =
  'BTW verlegd / VAT reverse-charged (art. 196 EU VAT Directive)';
export const NL_NOTICE_ICL =
  'BTW 0% — intracommunautaire levering (art. 138 EU-btw-richtlijn)';
export const NL_NOTICE_KOR =
  'Vrijgesteld van OB o.g.v. artikel 25 Wet OB (kleineondernemersregeling)';

export function getNlInvoiceRequirements(locale = 'nl-NL'): InvoiceRequirements {
  return {
    formatInvoiceNumber: (prefix, value, padding) =>
      `${prefix}${String(value).padStart(padding, '0')}`,
    defaultPadding: 4,
    requiredFields: ['vatNumber', 'registrationNumber', 'iban'],
    labels: locale.startsWith('nl') ? nlLabels : enLabels,
  };
}
