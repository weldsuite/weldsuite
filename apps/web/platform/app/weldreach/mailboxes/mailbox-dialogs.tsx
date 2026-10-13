import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  updateReachMailboxSchema,
  WELDREACH_SENDING_DEFAULTS,
  type ReachDomain,
  type ReachMailbox,
} from '@weldsuite/app-api-client/schemas/reach';
import { useUpdateReachMailbox } from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { createReachSchemaOptions } from '@/lib/reach/zod-error-map';
import { CreateMailboxForm } from '../components/create-mailbox-form';
import { warmupCopyParams } from '../lib/warmup';
import { NumberInput } from '@/components/shared/number-input';

// ---------------------------------------------------------------------------
// New mailbox
// ---------------------------------------------------------------------------

export function CreateMailboxDialog({
  open,
  onOpenChange,
  domains,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; domains: ReachDomain[] }>) {
  const t = useTranslations();
  const connectedDomains = domains.filter((domain) => domain.status === 'active');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('reach.mailboxes.create.title')}</DialogTitle>
          <DialogDescription>{t('reach.mailboxes.create.description', warmupCopyParams())}</DialogDescription>
        </DialogHeader>
        {open && (
          <CreateMailboxForm
            domains={connectedDomains}
            paymentReturnPath="/weldreach/mailboxes"
            onCreated={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit mailbox
// ---------------------------------------------------------------------------

type EditFormInput = z.input<typeof updateReachMailboxSchema>;
type EditFormOutput = z.output<typeof updateReachMailboxSchema>;

export function EditMailboxDialog({
  mailbox,
  onOpenChange,
}: Readonly<{ mailbox: ReachMailbox | null; onOpenChange: (open: boolean) => void }>) {
  const t = useTranslations();
  const update = useUpdateReachMailbox();
  const schemaOptions = useMemo(() => createReachSchemaOptions(t), [t]);
  const max = WELDREACH_SENDING_DEFAULTS.mailboxDailyCapMax;

  const form = useForm<EditFormInput, unknown, EditFormOutput>({
    resolver: zodResolver(updateReachMailboxSchema, schemaOptions),
    defaultValues: { firstName: '', lastName: '', signature: '', dailyCap: undefined },
  });

  useEffect(() => {
    if (mailbox) {
      form.reset({
        firstName: mailbox.firstName,
        lastName: mailbox.lastName,
        signature: mailbox.signature ?? '',
        dailyCap: mailbox.dailyCap,
      });
    }
  }, [mailbox, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    if (!mailbox) return;
    try {
      await update.mutateAsync({
        id: mailbox.id,
        input: { ...values, signature: values.signature?.trim() ? values.signature : null },
      });
      toast.success(t('reach.mailboxes.edit.saved'));
      onOpenChange(false);
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  });

  return (
    <Dialog open={mailbox !== null} onOpenChange={(open) => (update.isPending ? undefined : onOpenChange(open))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('reach.mailboxes.edit.title')}</DialogTitle>
          <DialogDescription>{mailbox?.email}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('reach.mailboxes.edit.firstName')}</FormLabel>
                    <FormControl>
                      <Input autoComplete="off" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('reach.mailboxes.edit.lastName')}</FormLabel>
                    <FormControl>
                      <Input autoComplete="off" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="signature"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('reach.mailboxes.edit.signature')}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dailyCap"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('reach.mailboxes.edit.dailyCap')}</FormLabel>
                  <FormControl>
                    <NumberInput
                      min={1}
                      max={max}
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value}
                      onValueChange={field.onChange}
                    />
                  </FormControl>
                  <FormDescription>
                    {t('reach.mailboxes.edit.dailyCapHint', { max, ramp: mailbox?.rampCurrent ?? 0 })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={update.isPending} onClick={() => onOpenChange(false)}>
                {t('common.actions.cancel')}
              </Button>
              <Button type="submit" disabled={update.isPending}>
                {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('reach.mailboxes.edit.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
