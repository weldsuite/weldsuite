/**
 * The supplier of a document on the review screen: the picker, a chip when the
 * scan matched a known supplier, the "as on the last bills" hint, and a "new
 * supplier from this document" section that opens inline (no second dialog).
 */

import { useId, useState } from 'react';
import { BadgeCheck, UserPlus } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { ContactPicker } from '@/components/accounting/contact-picker';
import { RecordLink } from '@/components/object-panel/record-link';
import { accountingKeys, useAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { useBookingDefaults } from '@/hooks/queries/use-weldbooks-receipts-queries';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import type { InboxOcrResult } from '@/lib/api/domains/weldbooks-receipts';
import { plural } from '@/lib/i18n/plural';
import { getLocale } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';

export interface SupplierSectionProps {
  contactId: string;
  onChange: (contactId: string) => void;
  /** The supplier the scan matched, for the "known supplier" chip. */
  matchedContactId: string | null;
  matchedName: string | null;
  /** What the scan read of the supplier, to start the new-supplier section from. */
  vendor: InboxOcrResult['vendor'];
  invalid?: boolean;
  describedBy?: string;
}

export function SupplierSection({ contactId, onChange, matchedContactId, matchedName, vendor, invalid, describedBy }: Readonly<SupplierSectionProps>) {
  const { t } = useI18n();
  const ts = t.weldbooksReceipts.review.supplier;
  const tr = t.weldbooksReceipts.review;
  const ids = useId();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(vendor?.name ?? '');
  const [vat, setVat] = useState(vendor?.taxNumber ?? '');
  const [iban, setIban] = useState(vendor?.iban ?? '');
  const defaults = useBookingDefaults(contactId);
  const supplierName = useAccountingCustomer(contactId).data?.data?.name ?? matchedName ?? '';

  const create = useMutation({
    mutationFn: () =>
      accountingApi.createCustomer({
        name: name.trim(),
        role: 'supplier',
        vatNumber: vat.trim() || null,
        iban: iban.trim() || null,
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: accountingKeys.customers.all });
      if (res?.data?.id) onChange(res.data.id);
      setAdding(false);
    },
  });

  const known = contactId !== '' && contactId === matchedContactId;
  const basedOnBills = defaults.data?.basedOnBills ?? 0;
  const hasDefaults = Boolean(defaults.data?.account || defaults.data?.taxRate);

  return (
    <div className="space-y-2">
      <Label htmlFor={`${ids}-supplier`}>{ts.label}</Label>
      <ContactPicker
        id={`${ids}-supplier`}
        role="supplier"
        value={contactId}
        onChange={onChange}
        placeholder={ts.placeholder}
        searchPlaceholder={ts.search}
        invalid={invalid}
        aria-describedby={describedBy}
      />

      {known ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="known-supplier">
          <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
          <RecordLink type="weldbooks_contact" id={contactId} label={supplierName || ts.known} tone="success" statusLabel={ts.known} />
          <span>
            {ts.known} · {ts.knownHint}
          </span>
        </p>
      ) : null}

      {contactId && hasDefaults && basedOnBills > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="booking-defaults-hint">
          {plural(basedOnBills, tr.defaultsHint, getLocale()).replace('{supplier}', supplierName)}
        </p>
      ) : null}

      {!adding ? (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() => {
            setName(vendor?.name ?? '');
            setVat(vendor?.taxNumber ?? '');
            setIban(vendor?.iban ?? '');
            setAdding(true);
          }}
        >
          <UserPlus className="mr-1 h-3.5 w-3.5" aria-hidden />
          {ts.newFromDocument}
        </Button>
      ) : (
        <section aria-labelledby={`${ids}-new`} className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="new-supplier">
          <h3 id={`${ids}-new`} className="text-sm font-medium">
            {ts.newTitle}
          </h3>
          {!vendor?.name ? <p className="text-xs text-muted-foreground">{ts.noNameOnDocument}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${ids}-name`}>{ts.name}</Label>
              <Input id={`${ids}-name`} value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-vat`}>{ts.vat}</Label>
              <Input id={`${ids}-vat`} value={vat} onChange={(event) => setVat(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-iban`}>{ts.iban}</Label>
              <Input id={`${ids}-iban`} value={iban} onChange={(event) => setIban(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </div>
          </div>
          {create.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {ts.createFailed}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? ts.creating : ts.create}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {ts.cancel}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
