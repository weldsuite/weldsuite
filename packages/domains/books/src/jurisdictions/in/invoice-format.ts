import type { InvoiceLabels, InvoiceRequirements } from '../types';

const enLabels: InvoiceLabels = {
  invoice: 'Tax Invoice',
  creditNote: 'Credit Note',
  invoiceNumber: 'Invoice number',
  date: 'Date',
  dueDate: 'Due date',
  billTo: 'Bill to',
  description: 'Description',
  quantity: 'Quantity',
  unitPrice: 'Unit price',
  tax: 'GST',
  amount: 'Amount',
  subtotal: 'Subtotal',
  discount: 'Discount',
  taxTotal: 'GST total',
  total: 'Total',
  amountPaid: 'Paid',
  balanceDue: 'Balance due',
  paymentInstructions: 'Payment instructions',
  vatNumberLabel: 'GSTIN',
  registrationLabel: 'PAN',
};

export const IN_NOTICE_REVERSE_CHARGE = 'Tax payable under reverse charge';
export const IN_NOTICE_EXPORT = 'Supply meant for export under bond or LUT — without payment of IGST';

export function getInInvoiceRequirements(_locale = 'en-IN'): InvoiceRequirements {
  return {
    formatInvoiceNumber: (prefix, value, padding) =>
      `${prefix}${String(value).padStart(padding, '0')}`,
    defaultPadding: 4,
    requiredFields: ['vatNumber', 'registrationNumber'],
    requiredFooter: 'This is a computer-generated tax invoice.',
    labels: enLabels,
  };
}
