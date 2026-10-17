import { cleanPostalAddress, type PostalAddress } from '@/components/address/postal-address';
import { cleanTaxRateId } from '@/lib/weldbooks/document-tax';
import { amountOrUndefined, amountString, dimensionPayload } from '@/lib/weldbooks/document-tax-form';
import { exchangeRatePayload } from '@/lib/weldbooks/currencies';
import {
  brDocumentPayload,
  brLinePayload,
  type BrDocumentFiscalPayload,
  type BrDocumentValues,
  type BrLineFiscalPayload,
  type BrLineValues,
} from '@/lib/weldbooks/br-fiscal';

/** A line of the bill form. */
export interface BillLineValues extends Partial<BrLineValues> {
  description: string;
  quantity: number | string;
  unitPrice: number | string;
  unit?: string;
  discountPercent?: number | string;
  /** VAT / GST rate (NL, IN); empty or `none` for no tax. */
  taxRateId?: string | null;
  /** US: the sales tax percentage the vendor charged on the line. */
  vendorTaxRate?: number | string | null;
  accountId?: string;
  /** US: the product tax code, which sets the use tax rate. `''` = general goods. */
  taxCode?: string;
  /** US: the vendor charged no sales tax; accrue use tax at the delivery address. */
  accrueUseTax?: boolean;
  /** 1099 box of the line: `''` = the account's default, `omit` = keep it out of 1099 reporting. */
  form1099Box?: string;
  classId?: string;
  locationId?: string;
}

export interface BillFormShape extends Partial<BrDocumentValues> {
  contactId: string;
  issueDate: string;
  dueDate: string;
  externalReference?: string;
  notes?: string;
  internalNotes?: string;
  /** ISO 4217 code; empty = the entity's currency. */
  currency?: string;
  /** Typed exchange rate (foreign units per base unit); empty = the rate of the issue date. */
  exchangeRate?: string;
  vendorAddress: PostalAddress;
  /** US: where the goods were delivered; the use tax rate follows it. */
  deliveryDifferent?: boolean;
  deliveryAddress?: PostalAddress;
  items: BillLineValues[];
}

/** The bills create/update body the form produces. */
export interface BillPayload {
  contactId: string;
  issueDate: string;
  dueDate: string;
  externalReference?: string;
  notes?: string;
  internalNotes?: string;
  currency?: string;
  /** Typed rate; `null` makes the server look the rate up again; absent keeps / looks up. */
  exchangeRate?: string | null;
  vendorAddress?: PostalAddress;
  /** `null` clears a stored delivery address on edit. */
  deliveryAddress?: PostalAddress | null;
  /** Brazil: withholdings and the supplier's NF-e access key; `null` clears them on edit. */
  fiscalData?: BrDocumentFiscalPayload | null;
  items: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    unit?: string;
    discountPercent?: string;
    /** null = no tax; never an empty string or placeholder. */
    taxRateId: string | null;
    /** US: the sales tax percentage the vendor charged. */
    taxRate?: string;
    accountId?: string;
    taxCode?: string | null;
    accrueUseTax?: boolean;
    /** null = the account's default box. */
    form1099Box?: string | null;
    classId: string | null;
    locationId: string | null;
    /** Brazil. */
    ncm?: string | null;
    cfop?: string | null;
    fiscalData?: BrLineFiscalPayload | null;
  }>;
}

export interface BillPayloadOptions {
  mode: 'add' | 'edit';
  /** The entity charges sales tax (a US entity): vendor tax is a rate on the line, use tax can be accrued. */
  salesTax: boolean;
  /** The entity files 1099s: lines carry a 1099 box. */
  form1099: boolean;
  /** The entity keeps Brazilian books: lines carry NCM, CFOP and fiscal details, the bill its withholdings. */
  br?: boolean;
  /** The user emptied an exchange rate the bill held: look it up again. */
  resetExchangeRate?: boolean;
}

/**
 * The create / update body of a bill. A VAT / GST entity sends its rate ids as
 * before. A US entity sends the sales tax the vendor charged as a rate on the
 * line (part of its cost), the tax code and the "accrue use tax" flag; the
 * use tax itself is the server's calculation. On edit an emptied address is
 * sent so the stored one is cleared.
 */
export function buildBillPayload(values: BillFormShape, options: BillPayloadOptions): BillPayload {
  const { mode, salesTax, form1099 } = options;
  const vendorAddress = cleanPostalAddress(values.vendorAddress);
  const delivery = values.deliveryDifferent ? cleanPostalAddress(values.deliveryAddress) : undefined;

  return {
    contactId: values.contactId,
    issueDate: values.issueDate,
    dueDate: values.dueDate,
    externalReference: values.externalReference || undefined,
    notes: values.notes || undefined,
    internalNotes: values.internalNotes || undefined,
    ...(values.currency ? { currency: values.currency } : {}),
    ...exchangeRatePayload(values.exchangeRate, options.resetExchangeRate),
    vendorAddress: vendorAddress ?? (mode === 'edit' ? {} : undefined),
    ...(salesTax ? { deliveryAddress: delivery ?? (mode === 'edit' ? null : undefined) } : {}),
    ...(options.br ? brBillFiscal(values, mode) : {}),
    items: values.items.map((item) => ({
      description: item.description,
      quantity: amountString(item.quantity, '1'),
      unitPrice: amountString(item.unitPrice, '0'),
      unit: item.unit || undefined,
      discountPercent: amountOrUndefined(item.discountPercent),
      taxRateId: salesTax ? null : cleanTaxRateId(item.taxRateId),
      ...(salesTax
        ? {
            taxRate: amountOrUndefined(item.vendorTaxRate),
            taxCode: item.taxCode || null,
            accrueUseTax: Boolean(item.accrueUseTax),
          }
        : {}),
      accountId: item.accountId || undefined,
      ...(form1099 ? { form1099Box: item.form1099Box || null } : {}),
      ...(options.br ? brLinePayload(item) : {}),
      ...dimensionPayload(item),
    })),
  };
}

/** Brazil: the bill's `fiscalData` (withholdings, access key); `null` on edit clears what a stored bill held. */
function brBillFiscal(values: BillFormShape, mode: 'add' | 'edit'): { fiscalData?: BrDocumentFiscalPayload | null } {
  const fiscalData = brDocumentPayload(values, { bill: true });
  return fiscalData || mode === 'edit' ? { fiscalData } : {};
}
