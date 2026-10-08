import { useEffect, useRef, type ReactNode } from 'react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { AddressFields } from '@/components/address/address-fields';
import {
  cleanPostalAddress,
  isPostalAddressEmpty,
  toPostalAddressFormValue,
  type PostalAddress,
} from '@/components/address/postal-address';
import { useAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { useI18n } from '@/lib/i18n/provider';

interface InvoiceAddressSectionProps {
  /** The selected customer. Changing it copies that contact's addresses in. */
  contactId: string;
  /**
   * The customer the current addresses already belong to (an edited
   * invoice's contact), so opening the form doesn't overwrite them.
   */
  initialContactId?: string | null;
  billingAddress: PostalAddress;
  shippingAddress: PostalAddress;
  shipToDifferent: boolean;
  onBillingAddressChange: (next: PostalAddress) => void;
  onShippingAddressChange: (next: PostalAddress) => void;
  onShipToDifferentChange: (next: boolean) => void;
  idPrefix?: string;
  /** A notice above the addresses, e.g. that the sales tax needs a ship-to state and ZIP code. */
  notice?: ReactNode;
}

function sameAddress(a: PostalAddress | null | undefined, b: PostalAddress | null | undefined): boolean {
  return JSON.stringify(cleanPostalAddress(a) ?? {}) === JSON.stringify(cleanPostalAddress(b) ?? {});
}

/**
 * Billing address (prefilled from the selected contact, editable per invoice)
 * and an optional "ship to a different address" block. Shared by the invoice
 * form and the quick-create dialog.
 */
export function InvoiceAddressSection({
  contactId,
  initialContactId,
  billingAddress,
  shippingAddress,
  shipToDifferent,
  onBillingAddressChange,
  onShippingAddressChange,
  onShipToDifferentChange,
  idPrefix = 'invoice',
  notice,
}: Readonly<InvoiceAddressSectionProps>) {
  const { t } = useI18n();
  const ta = t.accounting.invoiceAddresses;
  const { data: contactData } = useAccountingCustomer(contactId);
  const prefilledFor = useRef<string | null>(initialContactId ?? null);

  const contact = contactData?.data;

  useEffect(() => {
    if (!contactId || !contact || contact.id !== contactId) return;
    if (prefilledFor.current === contactId) return;
    prefilledFor.current = contactId;

    const billing = normalizeAccountingAddress(contact.billingAddress);
    const shipping = normalizeAccountingAddress(contact.shippingAddress);
    onBillingAddressChange(toPostalAddressFormValue(billing));
    const separateShipping = !!shipping && !sameAddress(billing, shipping);
    onShippingAddressChange(toPostalAddressFormValue(separateShipping ? shipping : null));
    onShipToDifferentChange(separateShipping);
  }, [contactId, contact, onBillingAddressChange, onShippingAddressChange, onShipToDifferentChange]);

  return (
    <div className="space-y-4">
      {notice}
      <div className="space-y-2">
        <p className="text-sm font-medium">{ta.billingAddress}</p>
        <p className="text-xs text-muted-foreground">{ta.billingAddressHelp}</p>
        <AddressFields
          idPrefix={`${idPrefix}-billing`}
          value={billingAddress}
          onChange={onBillingAddressChange}
        />
      </div>

      <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-shipToDifferent`}>
        <Checkbox
          id={`${idPrefix}-shipToDifferent`}
          checked={shipToDifferent}
          onCheckedChange={(checked) => {
            const next = checked === true;
            onShipToDifferentChange(next);
            if (next && isPostalAddressEmpty(shippingAddress)) {
              onShippingAddressChange({ ...billingAddress });
            }
          }}
        />
        {ta.shipToDifferent}
      </label>

      {shipToDifferent && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{ta.shippingAddress}</p>
          <AddressFields
            idPrefix={`${idPrefix}-shipping`}
            value={shippingAddress}
            onChange={onShippingAddressChange}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The address part of an invoice create/update body. On edit, an address
 * that was emptied (or a ship-to that was switched off) is sent as `{}` so
 * the stored one is cleared.
 */
export function invoiceAddressPayload(
  values: { billingAddress: PostalAddress; shippingAddress: PostalAddress; shipToDifferent: boolean },
  mode: 'add' | 'edit',
): { billingAddress?: PostalAddress; shippingAddress?: PostalAddress } {
  const empty = mode === 'edit' ? {} : undefined;
  const billing = cleanPostalAddress(values.billingAddress);
  const shipping = values.shipToDifferent ? cleanPostalAddress(values.shippingAddress) : undefined;
  return {
    billingAddress: billing ?? empty,
    shippingAddress: shipping ?? empty,
  };
}
