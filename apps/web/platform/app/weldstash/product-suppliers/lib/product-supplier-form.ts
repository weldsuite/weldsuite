/**
 * The product supplier form: the text the inputs hold, and the requests the
 * API takes (`POST` and `PATCH /product-suppliers`). Pure, so the rules are
 * tested apart from the dialog.
 *
 * Empty optional inputs are sent as null on a change (clearing an earlier
 * value) and left out on a create.
 */

import { z } from 'zod';
import {
  createProductSupplierSchema,
  updateProductSupplierSchema,
  type CreateProductSupplierInput,
  type ProductSupplier,
  type UpdateProductSupplierInput,
} from '@weldsuite/app-api-client/schemas/product-suppliers';

export interface ProductSupplierFormValues {
  supplierId: string;
  productId: string;
  supplierSku: string;
  supplierProductName: string;
  unitCost: string;
  currency: string;
  leadTimeDays: string;
  minOrderQty: string;
  orderMultiple: string;
  isPreferred: boolean;
}

export type ProductSupplierFormField = keyof ProductSupplierFormValues;

export const EMPTY_PRODUCT_SUPPLIER_FORM: ProductSupplierFormValues = {
  supplierId: '',
  productId: '',
  supplierSku: '',
  supplierProductName: '',
  unitCost: '',
  currency: '',
  leadTimeDays: '',
  minOrderQty: '',
  orderMultiple: '1',
  isPreferred: false,
};

const text = (value: string | number | null | undefined) => (value === null || value === undefined ? '' : String(value));

export function productSupplierToForm(row: ProductSupplier): ProductSupplierFormValues {
  return {
    supplierId: row.supplierId,
    productId: row.productId,
    supplierSku: text(row.supplierSku),
    supplierProductName: text(row.supplierProductName),
    unitCost: row.unitCost === null ? '' : String(Number(row.unitCost)),
    currency: text(row.currency),
    leadTimeDays: text(row.leadTimeDays),
    minOrderQty: text(row.minOrderQty),
    orderMultiple: text(row.orderMultiple),
    isPreferred: row.isPreferred,
  };
}

type ParsedNumber = number | null | 'invalid';

function parseNumber(value: string): ParsedNumber {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed.replace(',', '.'));
  return Number.isFinite(n) ? n : 'invalid';
}

export type ProductSupplierFormResult<T> =
  | { ok: true; input: T }
  | { ok: false; errors: Partial<Record<ProductSupplierFormField, 'required' | 'invalid'>> };

/** The shared part of a create and an update. `null` marks an emptied optional field. */
function terms(values: ProductSupplierFormValues) {
  const errors: Partial<Record<ProductSupplierFormField, 'required' | 'invalid'>> = {};
  const unitCost = parseNumber(values.unitCost);
  const lead = parseNumber(values.leadTimeDays);
  const min = parseNumber(values.minOrderQty);
  const multiple = parseNumber(values.orderMultiple);
  const currency = values.currency.trim().toUpperCase();

  if (unitCost === 'invalid' || (unitCost !== null && unitCost < 0)) errors.unitCost = 'invalid';
  if (lead === 'invalid' || (lead !== null && (!Number.isInteger(lead) || lead < 0 || lead > 365))) errors.leadTimeDays = 'invalid';
  if (min === 'invalid' || (min !== null && (!Number.isInteger(min) || min < 1))) errors.minOrderQty = 'invalid';
  if (multiple === 'invalid' || (multiple !== null && (!Number.isInteger(multiple) || multiple < 1))) errors.orderMultiple = 'invalid';
  if (currency !== '' && !/^[A-Z]{3}$/.test(currency)) errors.currency = 'invalid';

  return {
    errors,
    fields: {
      supplierSku: values.supplierSku.trim() || null,
      supplierProductName: values.supplierProductName.trim() || null,
      unitCost: unitCost === 'invalid' ? null : unitCost,
      currency: currency || null,
      leadTimeDays: lead === 'invalid' ? null : lead,
      minOrderQty: min === 'invalid' ? null : min,
      orderMultiple: multiple === 'invalid' || multiple === null ? 1 : multiple,
      isPreferred: values.isPreferred,
    },
  };
}

/** `POST /product-suppliers` for the form; empty optional fields are left out. */
export function formToCreateInput(
  values: ProductSupplierFormValues,
  item: { productId: string; variantId?: string | null },
): ProductSupplierFormResult<CreateProductSupplierInput> {
  const { errors, fields } = terms(values);
  if (!values.supplierId) errors.supplierId = 'required';
  if (!item.productId) errors.productId = 'required';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const optional = Object.fromEntries(
    Object.entries({
      supplierSku: fields.supplierSku,
      supplierProductName: fields.supplierProductName,
      unitCost: fields.unitCost,
      currency: fields.currency,
      leadTimeDays: fields.leadTimeDays,
      minOrderQty: fields.minOrderQty,
    }).filter(([, v]) => v !== null),
  );
  const parsed = createProductSupplierSchema.safeParse({
    productId: item.productId,
    ...(item.variantId ? { variantId: item.variantId } : {}),
    supplierId: values.supplierId,
    ...optional,
    orderMultiple: fields.orderMultiple,
    isPreferred: fields.isPreferred,
  });
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false, errors: { unitCost: 'invalid' } };
}

/** `PATCH /product-suppliers/{id}` for the form; an emptied field is sent as null so it clears. */
export function formToUpdateInput(values: ProductSupplierFormValues): ProductSupplierFormResult<UpdateProductSupplierInput> {
  const { errors, fields } = terms(values);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const parsed = updateProductSupplierSchema.safeParse(fields);
  return parsed.success ? { ok: true, input: parsed.data } : { ok: false, errors: { unitCost: 'invalid' } };
}

/** The zod schema the form validates with (react-hook-form's resolver), with messages in the user's language. */
export function makeProductSupplierFormSchema(
  messages: Readonly<{ required: string; invalid: string }>,
  mode: { kind: 'create'; productId: string } | { kind: 'update' },
) {
  return z
    .object({
      supplierId: z.string(),
      productId: z.string(),
      supplierSku: z.string(),
      supplierProductName: z.string(),
      unitCost: z.string(),
      currency: z.string(),
      leadTimeDays: z.string(),
      minOrderQty: z.string(),
      orderMultiple: z.string(),
      isPreferred: z.boolean(),
    })
    .superRefine((values, ctx) => {
      const result =
        mode.kind === 'create'
          ? formToCreateInput(values, { productId: mode.productId || values.productId })
          : formToUpdateInput(values);
      if (result.ok) return;
      for (const [field, code] of Object.entries(result.errors) as Array<[ProductSupplierFormField, 'required' | 'invalid']>) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: messages[code] });
      }
    });
}
