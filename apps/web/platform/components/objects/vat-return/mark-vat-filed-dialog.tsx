/**
 * "Mark as filed" for a VAT return, on editions with no Digipoort: the return
 * was filed with the tax authority by hand, so the member records when and
 * under which reference. Both are optional; the date defaults to today.
 */

import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const schema = z.object({
  filingReference: z.string().max(100).optional(),
  filedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
});

type MarkFiledValues = z.infer<typeof schema>;

export function MarkVatFiledDialog({
  open,
  onOpenChange,
  pending,
  onSubmit,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (values: { filingReference?: string; filedAt?: string }) => void;
}>) {
  const st = useTranslations();
  const { today } = useWeldbooksFormat();
  const defaults = useMemo<MarkFiledValues>(() => ({ filingReference: '', filedAt: today() }), [today]);
  const { register, handleSubmit, reset } = useForm<MarkFiledValues>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });

  // Every opening starts from an empty reference and today.
  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const submit = (values: MarkFiledValues) =>
    onSubmit({
      filingReference: values.filingReference?.trim() || undefined,
      filedAt: values.filedAt || undefined,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{st('sweep.weldbooks.records.markFiledTitle')}</DialogTitle>
          <DialogDescription>{st('sweep.weldbooks.records.markFiledDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="filingReference">{st('sweep.weldbooks.records.filingReferenceOptional')}</Label>
            <Input id="filingReference" maxLength={100} {...register('filingReference')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="filedAt">{st('sweep.weldbooks.records.filedOn')}</Label>
            <Input id="filedAt" type="date" {...register('filedAt')} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {st('sweep.weldbooks.records.cancel')}
            </Button>
            <Button type="submit" disabled={pending}>
              {st('sweep.weldbooks.records.markFiled')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
