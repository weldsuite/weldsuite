/**
 * Fix a recipient's name or email on a sent request. For a signer whose turn it
 * is, the old link stops working and a new one goes to the new address (the
 * server does both); for anyone else the new address is simply used from now on.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { correctRecipientSchema, type SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { useCorrectSignRecipient } from '@/hooks/queries/use-weldsign-queries';
import { isConflict, lifecycleErrorMessage } from '../lib/errors';
import { isSigningNow } from '../lib/recipients';

type FormInput = z.input<typeof correctRecipientSchema>;
type FormOutput = z.output<typeof correctRecipientSchema>;

interface CorrectRecipientDialogProps {
  envelopeId: string;
  /** The recipient being corrected; null keeps the dialog closed. */
  recipient: SignRecipientDto | null;
  onClose: () => void;
}

export function CorrectRecipientDialog({ envelopeId, recipient, onClose }: Readonly<CorrectRecipientDialogProps>) {
  // Mounted per recipient, so every opening starts from their current details.
  return recipient ? <CorrectRecipientForm key={recipient.id} envelopeId={envelopeId} recipient={recipient} onClose={onClose} /> : null;
}

function CorrectRecipientForm({ envelopeId, recipient, onClose }: Readonly<{ envelopeId: string; recipient: SignRecipientDto; onClose: () => void }>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const tc = to.correct;
  const tr = t.weldsign.editor.recipients;

  const correct = useCorrectSignRecipient(envelopeId, (err) => {
    toast.error(lifecycleErrorMessage(err, tc.failed, to.notOpen));
    // The request closed in the meantime: there is nothing left to correct.
    if (isConflict(err)) onClose();
  });

  // The contract's own schema, with its messages in the UI language.
  const schemaOptions = useMemo(
    () => ({
      errorMap: (issue: z.ZodIssueOptionalMessage, ctx: z.ErrorMapCtx) => {
        if (issue.path[0] === 'name') return { message: tr.nameRequired };
        if (issue.path[0] === 'email') return { message: tr.invalidEmail };
        return { message: ctx.defaultError };
      },
      path: [] as Array<string | number>,
      async: false,
    }),
    [tr.nameRequired, tr.invalidEmail],
  );

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(correctRecipientSchema, schemaOptions),
    defaultValues: { name: recipient.name ?? '', email: recipient.email ?? '' },
  });

  const [name, email] = form.watch(['name', 'email']);
  // The server refuses a correction that changes nothing.
  const unchanged = (name ?? '').trim() === (recipient.name ?? '') && email.trim().toLowerCase() === (recipient.email ?? '').toLowerCase();

  const onSubmit = form.handleSubmit((values) =>
    correct.mutate(
      {
        recipientId: recipient.id,
        input: { email: values.email, name: values.name === recipient.name ? undefined : values.name },
      },
      {
        onSuccess: () => {
          toast.success(tc.done);
          onClose();
        },
      },
    ),
  );

  const label = recipient.name || recipient.email || '';

  return (
    // Stays open while the correction is being saved: the outcome is shown in this dialog.
    <Dialog open onOpenChange={(open) => !open && !correct.isPending && onClose()}>
      <DialogContent>
        <Form {...form}>
          <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>{tc.title}</DialogTitle>
              <DialogDescription>
                {format(isSigningNow(recipient) ? tc.descriptionActive : tc.descriptionOther, { name: label })}
              </DialogDescription>
            </DialogHeader>

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tc.name}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} maxLength={255} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tc.email}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" maxLength={320} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" disabled={correct.isPending} onClick={onClose}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={correct.isPending || unchanged}>
                {correct.isPending ? tc.saving : tc.save}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
