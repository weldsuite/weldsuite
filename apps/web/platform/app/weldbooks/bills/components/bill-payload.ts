import { cleanPostalAddress, type PostalAddress } from '@/components/address/postal-address';
import { cleanTaxRateId } from '@/lib/weldbooks/document-tax';
import { amountOrUndefined, amountString, dimensionPayload } from '@/lib/weldbooks/document-tax-form';

/** A line of the bill form. */
export interface BillLineValues {
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

export interface BillFormShape {
  contactId: string;
  issueDate: string;
  dueDate: string;
  externalReference?: string;
  notes?: string;
  internalNotes?: string;
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
  vendorAddress?: PostalAddress;
  /** `null` clears a stored delivery address on edit. */
  deliveryAddress?: PostalAddress | null;
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
  }>;
}

export interface BillPayloadOptions {
  mode: 'add' | 'edit';
  /** The entity charges sales tax (a US entity): vendor tax is a rate on the line, use tax can be accrued. */
  salesTax: boolean;
  /** The entity files 1099s: lines carry a 1099 box. */
  form1099: boolean;
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
    vendorAddress: vendorAddress ?? (mode === 'edit' ? {} : undefined),
    ...(salesTax ? { deliveryAddress: delivery ?? (mode === 'edit' ? null : undefined) } : {}),
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
      ...dimensionPayload(item),
    })),
  };
}
