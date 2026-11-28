/**
 * "Make invoice" from a quote: the whole quote (100%) or a share of it as an
 * advance invoice, and the legal entity that invoices when there is more than
 * one. The draft invoice that comes back opens in a stacked panel.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { NumberInput } from '@weldsuite/ui/components/number-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useObjectPanel } from '@/components/object-panel';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useAccountingEntities } from '@/hooks/use-current-entity-currency';
import { useInvoiceFromQuote } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { QuoteDetail } from '@/lib/api/domains/weldbooks-sales';
import { useI18n } from '@/lib/i18n/provider';
import { shareLeft } from '@/lib/weldbooks/quote-status';

function statusOf(error: unknown): number | null {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : null;
  return typeof status === 'number' ? status : null;
}

type Share = 'whole' | 'part';

function MakeInvoiceForm({ quote, onClose }: Readonly<{ quote: QuoteDetail; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.makeInvoice;
  const { open: openPanel } = useObjectPanel();
  const { entityId: currentEntityId } = useCurrentAccountingEntity();
  const { data: entities } = useAccountingEntities();
  const make = useInvoiceFromQuote();
  const left = shareLeft(quote);
  const alreadyInvoiced = quote.invoices.length > 0;
  const [share, setShare] = useState<Share>(alreadyInvoiced ? 'part' : 'whole');
  const [percentage, setPercentage] = useState<number | undefined>(alreadyInvoiced ? Math.max(1, left) : 50);
  const [entityId, setEntityId] = useState<string>(currentEntityId ?? '');
  const several = (entities?.length ?? 0) > 1;
  const invalid = share === 'part' && (percentage === undefined || percentage < 1 || percentage > 100);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (invalid) return;
    make.mutate(
      {
        quoteId: quote.id,
        input: {
          ...(several && entityId ? { entityId } : {}),
          ...(share === 'part' && percentage !== undefined ? { percentage } : {}),
        },
      },
      {
        onSuccess: (res) => {
          toast.success(copy.created);
          onClose();
          openPanel({ type: 'invoice', id: res.data.id, stack: true });
        },
        onError: (error) =>
          toast.error(copy.failed, {
            description: statusOf(error) === 409 ? copy.tooMuch.replace('{percentage}', String(left)) : error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">{copy.share}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="share" checked={share === 'whole'} onChange={() => setShare('whole')} className="accent-primary" />
          {copy.whole}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="share" checked={share === 'part'} onChange={() => setShare('part')} className="accent-primary" />
          {copy.part}
        </label>
        {share === 'part' ? (
          <div className="ml-6 space-y-1">
            <div className="flex items-center gap-2">
              <Label htmlFor="make-percentage" className="sr-only">
                {copy.percentage}
              </Label>
              <NumberInput
                id="make-percentage"
                value={percentage}
                onValueChange={setPercentage}
                min={1}
                max={100}
                className="w-24"
                aria-invalid={invalid ? true : undefined}
                aria-describedby="make-percentage-hint"
              />
              <span aria-hidden>%</span>
            </div>
            <p id="make-percentage-hint" className="text-xs text-muted-foreground">
              {alreadyInvoiced ? copy.leftHint.replace('{percentage}', String(left)) : copy.advanceHint}
            </p>
          </div>
        ) : null}
      </fieldset>

      {several ? (
        <div className="space-y-1.5">
          <Label htmlFor="make-entity">{copy.entity}</Label>
          <Select value={entityId} onValueChange={setEntityId}>
            <SelectTrigger id="make-entity">
              <SelectValue placeholder={copy.entity} />
            </SelectTrigger>
            <SelectContent>
              {(entities ?? []).map((entity) => (
                <SelectItem key={entity.id} value={entity.id}>
                  {entity.name ?? entity.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {copy.cancel}
        </Button>
        <Button type="submit" disabled={make.isPending || invalid}>
          {make.isPending ? copy.making : copy.make}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function MakeInvoiceDialog({
  quote,
  open,
  onOpenChange,
}: Readonly<{ quote: QuoteDetail; open: boolean; onOpenChange: (open: boolean) => void }>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open ? <MakeInvoiceForm quote={quote} onClose={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  );
}
