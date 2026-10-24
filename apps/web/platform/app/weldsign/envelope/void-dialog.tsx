/**
 * Void a sent request. The reason is required: signers who already got the
 * request are emailed it, and their links stop working. This cannot be undone.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { voidEnvelopeSchema } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { useVoidSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { isConflict, lifecycleErrorMessage } from '../lib/errors';

type FormInput = z.input<typeof voidEnvelopeSchema>;
type FormOutput = z.output<typeof voidEnvelopeSchema>;

interface VoidDialogProps {
  envelopeId: string;
  title: string;
  open: boolean;
  onClose: () => void;
}

export function VoidDialog({ envelopeId, title, open, onClose }: Readonly<VoidDialogProps>) {
  // Mounted per opening, so a reason typed earlier is not carried over.
  return open ? <VoidForm envelopeId={envelopeId} title={title} onClose={onClose} /> : null;
}

function VoidForm({ envelopeId, title, onClose }: Readonly<Omit<VoidDialogProps, 'open'>>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const tv = to.void;

  const voidRequest = useVoidSignEnvelope(envelopeId, (err) => {
    toast.error(lifecycleErrorMessage(err, tv.failed, to.notOpen));
    // The request closed in the meantime: there is nothing left to void.
    if (isConflict(err)) onClose();
  });

  const schemaOptions = useMemo(
    () => ({
      errorMap: (issue: z.ZodIssueOptionalMessage, ctx: z.ErrorMapCtx) =>
        issue.path[0] === 'reason' ? { message: tv.reasonRequired } : { message: ctx.defaultError },
      path: [] as Array<string | number>,
      async: false,
    }),
    [tv.reasonRequired],
  );

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(voidEnvelopeSchema, schemaOptions),
    defaultValues: { reason: '' },
  });
  const reason = form.watch('reason');

  const onSubmit = form.handleSubmit((values) =>
    voidRequest.mutate(values, {
      onSuccess: () => {
        toast.success(tv.done);
        onClose();
      },
    }),
  );

  return (
    // Stays open while the request is being voided: the outcome is shown in this dialog.
    <Dialog open onOpenChange={(next) => !next && !voidRequest.isPending && onClose()}>
      <DialogContent>
        <Form {...form}>
          <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>{tv.title}</DialogTitle>
              <DialogDescription>{format(tv.description, { title })}</DialogDescription>
            </DialogHeader>

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tv.reason}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={4} maxLength={1000} placeholder={tv.reasonPlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" disabled={voidRequest.isPending} onClick={onClose}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" variant="destructive" disabled={voidRequest.isPending || reason.trim() === ''}>
                {voidRequest.isPending ? tv.voiding : tv.confirm}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
