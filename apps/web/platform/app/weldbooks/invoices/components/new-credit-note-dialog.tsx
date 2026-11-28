/**
 * "New credit note" from the Invoices list: pick the invoice to credit, then the
 * draft credit note that mirrors it opens in the editor (the same route as
 * "Create credit note" in an invoice's menu).
 */

import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Autocomplete, type AutocompleteOption } from '@weldsuite/ui/components/autocomplete';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { accountingKeys } from '@/hooks/queries/use-accounting-queries';
import { useCreateCreditMemo } from '@/hooks/queries/use-weldbooks-tax-preview';
import { accountingApi, type Invoice } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useDescribeError } from './sales-tax-error-notice';

/** A credit note is written against an invoice that was issued and not cancelled. */
export function canBeCredited(invoice: Pick<Invoice, 'type' | 'status'>): boolean {
  return invoice.type !== 'credit_note' && invoice.status !== 'draft' && invoice.status !== 'cancelled';
}

const PICKER_PAGE_SIZE = 25;

export function NewCreditNoteDialog({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.creditNote;
  const router = useRouter();
  const qc = useQueryClient();
  const { formatMoney } = useWeldbooksFormat();
  const describeError = useDescribeError();
  const createCreditMemo = useCreateCreditMemo();
  const [invoiceId, setInvoiceId] = useState('');
  /** Every option the search listed, so the trigger can name the chosen invoice once the list moves on. */
  const seen = useRef(new Map<string, AutocompleteOption>());

  const optionOf = useCallback(
    (invoice: Invoice): AutocompleteOption => ({
      value: invoice.id,
      label: invoice.invoiceNumber ?? invoice.id,
      description: [invoice.contactName, formatMoney(invoice.total, invoice.currency)].filter(Boolean).join(' · '),
    }),
    [formatMoney],
  );

  const search = useCallback(
    async (query: string) => {
      const filters = { type: 'invoice', search: query.trim() || undefined, pageSize: PICKER_PAGE_SIZE };
      const res = await qc.fetchQuery({
        queryKey: [...accountingKeys.invoices.list(filters), 'credit-picker'] as const,
        queryFn: () => accountingApi.listInvoices(filters),
        staleTime: 15_000,
      });
      const options = (res.data ?? []).filter(canBeCredited).map(optionOf);
      for (const option of options) seen.current.set(option.value, option);
      return options;
    },
    [qc, optionOf],
  );

  const create = () => {
    if (!invoiceId) return;
    createCreditMemo.mutate(invoiceId, {
      onSuccess: (res) => {
        onOpenChange(false);
        toast.success(copy.created.replace('{number}', res.data.invoiceNumber));
        // The draft mirrors the invoice: open it to credit part of it, or finalize it as it is.
        router.push(`/weldbooks/invoices/${res.data.id}/edit`);
      },
      onError: (error) => toast.error(copy.failed, { description: describeError(error) }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="credit-invoice">{copy.invoice}</Label>
          <Autocomplete
            id="credit-invoice"
            value={invoiceId}
            onValueChange={(next) => {
              if (next) setInvoiceId(next);
            }}
            onSearch={search}
            selectedOption={seen.current.get(invoiceId)}
            minSearchLength={0}
            debounceMs={250}
            placeholder={copy.placeholder}
            searchPlaceholder={copy.searchPlaceholder}
            searchingText={copy.searching}
            emptyText={copy.noResults}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button type="button" onClick={create} disabled={!invoiceId || createCreditMemo.isPending}>
            {createCreditMemo.isPending ? copy.creating : copy.create}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
