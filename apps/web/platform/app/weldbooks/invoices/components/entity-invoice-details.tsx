/**
 * The company details an invoice must carry (VAT number, KvK, IBAN, address,
 * per jurisdiction), asked for where invoices are made: a notice that names
 * what is missing, and a dialog that fills in just those fields.
 *
 * books-api refuses to finalize or send an invoice without them; asking here
 * keeps the user from finding out only after the invoice is written.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { AddressFields } from '@/components/address/address-fields';
import { cleanPostalAddress, toPostalAddressFormValue, type PostalAddress } from '@/components/address/postal-address';
import { useUpdateAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import type { AccountingEntity, UpdateAccountingEntityInput } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { isValidIban, isValidKvk } from '@/lib/weldbooks/identifiers';
import type { InvoiceField } from '@/lib/weldbooks/invoice-requirements';

/** The entity's address is in its own country: the form starts from the jurisdiction's. */
const ADDRESS_COUNTRY_BY_JURISDICTION: Record<string, string> = { US: 'US', NL: 'NL', IN: 'IN', BR: 'BR' };

function initialAddress(entity: AccountingEntity): PostalAddress {
  const address = toPostalAddressFormValue(normalizeAccountingAddress(entity.address));
  const country = ADDRESS_COUNTRY_BY_JURISDICTION[entity.jurisdictionCode?.toUpperCase() ?? ''];
  return country && !address.country?.trim() ? { ...address, country } : address;
}

interface DetailsValues {
  vatNumber: string;
  registrationNumber: string;
  iban: string;
  bic: string;
  address: PostalAddress;
}

type DetailsErrors = Partial<Record<InvoiceField, string>>;

function detailsErrors(
  values: DetailsValues,
  fields: readonly InvoiceField[],
  messages: { required: string; ibanInvalid: string; kvkInvalid: string; addressRequired: string },
  jurisdictionCode: string | null | undefined,
): DetailsErrors {
  const errors: DetailsErrors = {};
  const isNl = jurisdictionCode?.toUpperCase() === 'NL';
  for (const field of fields) {
    if (field === 'address') {
      if (!values.address.line1?.trim() || !values.address.city?.trim()) errors.address = messages.addressRequired;
    } else if (!values[field].trim()) {
      errors[field] = messages.required;
    } else if (field === 'iban' && !isValidIban(values.iban)) {
      errors.iban = messages.ibanInvalid;
    } else if (field === 'registrationNumber' && isNl && !isValidKvk(values.registrationNumber)) {
      // The same rule the API applies (8 digits), shown inline instead of in a toast.
      errors.registrationNumber = messages.kvkInvalid;
    }
  }
  return errors;
}

/** The update body: only the asked fields; the bank details are sent whole (the API replaces them). */
function detailsPayload(values: DetailsValues, fields: readonly InvoiceField[], entity: AccountingEntity) {
  const payload: UpdateAccountingEntityInput = {};
  const taxIdentifiers: NonNullable<UpdateAccountingEntityInput['taxIdentifiers']> = {};
  if (fields.includes('vatNumber')) taxIdentifiers.vatNumber = values.vatNumber.trim();
  if (fields.includes('registrationNumber')) taxIdentifiers.registrationNumber = values.registrationNumber.trim();
  if (Object.keys(taxIdentifiers).length > 0) payload.taxIdentifiers = taxIdentifiers;

  if (fields.includes('iban') || fields.includes('bic')) {
    const bankDetails: NonNullable<UpdateAccountingEntityInput['bankDetails']> = {};
    for (const [key, value] of Object.entries(entity.bankDetails ?? {})) {
      if (typeof value === 'string' && value.trim()) bankDetails[key as keyof typeof bankDetails] = value;
    }
    if (fields.includes('iban')) bankDetails.iban = values.iban.replaceAll(/\s+/g, '').toUpperCase();
    if (fields.includes('bic')) bankDetails.bic = values.bic.trim().toUpperCase();
    payload.bankDetails = bankDetails;
  }

  if (fields.includes('address')) payload.address = cleanPostalAddress(values.address) ?? {};
  return payload;
}

interface EntityInvoiceDetailsDialogProps {
  entity: AccountingEntity;
  /** The fields to ask for: the ones the entity is missing. */
  fields: readonly InvoiceField[];
  labels: Record<InvoiceField, string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Fills in the missing invoice details of the entity, nothing else. It starts
 * empty when mounted: give it a new `key` for each opening.
 */
export function EntityInvoiceDetailsDialog({
  entity,
  fields,
  labels,
  open,
  onOpenChange,
}: Readonly<EntityInvoiceDetailsDialogProps>) {
  const { t } = useI18n();
  const td = t.accounting.entityInvoiceDetails;
  const updateEntity = useUpdateAccountingEntity();
  // The fields asked when the dialog opened: the list shrinks as soon as the saved entity reloads.
  const [asked] = useState<readonly InvoiceField[]>(fields);
  const [values, setValues] = useState<DetailsValues>(() => ({
    vatNumber: '',
    registrationNumber: '',
    iban: '',
    bic: '',
    address: initialAddress(entity),
  }));
  const [errors, setErrors] = useState<DetailsErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const messages = {
    required: td.required,
    ibanInvalid: t.accounting.contacts.ibanInvalid,
    kvkInvalid: t.accounting.contacts.kvkInvalid,
    addressRequired: td.addressRequired,
  };

  const update = (patch: Partial<DetailsValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    if (submitted) setErrors(detailsErrors(next, asked, messages, entity.jurisdictionCode));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setSubmitted(true);
    const found = detailsErrors(values, asked, messages, entity.jurisdictionCode);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      await updateEntity.mutateAsync({ id: entity.id, data: detailsPayload(values, asked, entity) });
      toast.success(td.saved);
      onOpenChange(false);
    } catch (err) {
      // e.g. a VAT number or GSTIN that is not valid for the jurisdiction.
      toast.error(td.saveFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const textField = (field: Exclude<InvoiceField, 'address'>, extra?: { placeholder?: string }) => (
    <div key={field} className="space-y-2">
      <Label htmlFor={`entity-invoice-${field}`}>{labels[field]}</Label>
      <Input
        id={`entity-invoice-${field}`}
        value={values[field]}
        placeholder={extra?.placeholder}
        aria-invalid={Boolean(errors[field])}
        onChange={(e) => update({ [field]: e.target.value })}
        disabled={updateEntity.isPending}
      />
      {errors[field] && <p className="text-sm text-destructive">{errors[field]}</p>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{td.dialogTitle}</DialogTitle>
            <DialogDescription>{td.dialogDescription.replace('{entity}', entity.legalName || entity.name)}</DialogDescription>
          </DialogHeader>

          {asked.includes('vatNumber') && textField('vatNumber')}
          {asked.includes('registrationNumber') && textField('registrationNumber')}
          {asked.includes('iban') && textField('iban', { placeholder: 'NL00 BANK 0123 4567 89' })}
          {asked.includes('bic') && textField('bic')}
          {asked.includes('address') && (
            <div className="space-y-2">
              <p className="text-sm font-medium">{labels.address}</p>
              <AddressFields
                idPrefix="entity-invoice-address"
                value={values.address}
                onChange={(address) => update({ address })}
                disabled={updateEntity.isPending}
              />
              {errors.address && <p className="text-sm text-destructive">{errors.address}</p>}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {td.otherDetails}{' '}
            <Link
              href={`/settings/entities/${entity.id}/edit`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {td.openSettings}
            </Link>
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={updateEntity.isPending}>
              {t.common.actions.cancel}
            </Button>
            <Button type="submit" disabled={updateEntity.isPending}>
              {updateEntity.isPending ? td.saving : td.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface EntityInvoiceDetailsNoticeProps {
  entity: AccountingEntity | undefined;
  missing: readonly InvoiceField[];
  labels: Record<InvoiceField, string>;
  /** `create`: a new invoice waits for the details; `issue`: a draft can't be finalized or sent without them. */
  context: 'create' | 'issue';
  className?: string;
}

/**
 * Names the details the entity is missing for an invoice, with a button that
 * fills them in. Renders nothing while nothing is missing.
 */
export function EntityInvoiceDetailsNotice({
  entity,
  missing,
  labels,
  context,
  className,
}: Readonly<EntityInvoiceDetailsNoticeProps>) {
  const { t } = useI18n();
  const td = t.accounting.entityInvoiceDetails;
  const canUpdate = useCan('entities:update');
  const [open, setOpen] = useState(false);
  // Each opening starts the dialog afresh, with the fields missing at that moment.
  const [opening, setOpening] = useState(0);
  if (!entity || missing.length === 0) return null;

  const fieldList = missing.map((field) => labels[field]).join(', ');
  const description = (context === 'create' ? td.createDescription : td.issueDescription).replace('{fields}', fieldList);

  return (
    <>
      <InfoBanner
        variant="warning"
        title={td.title}
        className={className}
        data-testid="entity-invoice-details-notice"
        action={
          canUpdate ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shadow-none"
              onClick={() => {
                setOpening((n) => n + 1);
                setOpen(true);
              }}
            >
              {td.add}
            </Button>
          ) : undefined
        }
      >
        <p>{description}</p>
        {!canUpdate && <p className="mt-1">{td.askAdmin}</p>}
      </InfoBanner>
      {canUpdate && (
        <EntityInvoiceDetailsDialog
          key={opening}
          entity={entity}
          fields={missing}
          labels={labels}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
