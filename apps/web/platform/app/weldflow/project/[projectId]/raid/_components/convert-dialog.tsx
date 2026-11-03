import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormField } from '@weldsuite/ui/components/form';
import { ISSUE_SEVERITIES } from '@weldsuite/app-api-client/schemas/project-control';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { useConvertRaidItem } from '@/hooks/queries/use-project-control-queries';
import {
  buildConvertBody,
  convertFormSchemaFor,
  convertValuesFromItem,
  raidResolverOptions,
  type ConvertFormValues,
} from '../_lib/form';
import { SelectField, TextField } from './form-fields';
import { RatingPicker, ScoreCard } from './rating-controls';

interface ConvertDialogProps {
  /** The assumption (to a risk) or risk (to an issue) to convert; the dialog is open while this is set. */
  item: RaidItem | null;
  onClose: () => void;
  /** Called with the new item once the conversion succeeded. */
  onConverted: (created: RaidItem) => void;
}

export function ConvertDialog({ item, onClose, onConverted }: Readonly<ConvertDialogProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const to = item?.kind === 'assumption' ? 'risk' : 'issue';
  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-xl">
        {item ? (
          <>
            <DialogHeader className="border-b px-6 pt-6 pb-4 text-left">
              <DialogTitle>{to === 'risk' ? copy.convert.titleToRisk : copy.convert.titleToIssue}</DialogTitle>
              <DialogDescription>
                {format(to === 'risk' ? copy.convert.descriptionToRisk : copy.convert.descriptionToIssue, { code: item.code })}
              </DialogDescription>
            </DialogHeader>
            <ConvertForm key={item.id} item={item} to={to} onClose={onClose} onConverted={onConverted} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConvertForm({
  item,
  to,
  onClose,
  onConverted,
}: Readonly<{ item: RaidItem; to: 'risk' | 'issue'; onClose: () => void; onConverted: (created: RaidItem) => void }>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const convert = useConvertRaidItem();
  const resolverOptions = useMemo(() => raidResolverOptions(copy.validation, format), [copy.validation, format]);
  const schema = useMemo(() => convertFormSchemaFor(to), [to]);

  const form = useForm<ConvertFormValues>({
    resolver: zodResolver(schema, resolverOptions),
    defaultValues: convertValuesFromItem(item),
  });
  const [probability, impact] = form.watch(['probability', 'impact']);

  const submit = async (values: ConvertFormValues) => {
    const body = buildConvertBody(to, values);
    if (!body) {
      toast.error(copy.toasts.convertFailed);
      return;
    }
    try {
      const result = (await convert.mutateAsync({ id: item.id, data: body })).data;
      toast.success(format(copy.toasts.converted, { code: result.item.code }));
      onClose();
      onConverted(result.item);
    } catch {
      toast.error(copy.toasts.convertFailed);
    }
  };

  return (
    <Form {...form}>
      <form noValidate onSubmit={form.handleSubmit(submit)} className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <TextField control={form.control} name="title" label={copy.convert.newTitle} autoFocus />
          {to === 'risk' ? (
            <>
              <FormField
                control={form.control}
                name="probability"
                render={({ field, fieldState }) => (
                  <RatingPicker label={copy.form.probability} kind="probability" value={field.value} onChange={field.onChange} error={fieldState.error?.message} />
                )}
              />
              <FormField
                control={form.control}
                name="impact"
                render={({ field, fieldState }) => (
                  <RatingPicker label={copy.form.impact} kind="impact" value={field.value} onChange={field.onChange} error={fieldState.error?.message} />
                )}
              />
              <ScoreCard probability={probability} impact={impact} />
            </>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                control={form.control}
                name="severity"
                label={copy.convert.severity}
                options={ISSUE_SEVERITIES.map((level) => ({ value: level, label: copy.severity[level] }))}
              />
              <TextField control={form.control} name="dueDate" type="date" label={copy.form.dueDate.issue} />
            </div>
          )}
        </div>
        <DialogFooter className="border-t px-6 py-3.5">
          <Button type="button" variant="outline" onClick={onClose} disabled={convert.isPending}>
            {t.common.actions.cancel}
          </Button>
          <Button type="submit" disabled={convert.isPending}>
            {convert.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {copy.convert.submit}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}
