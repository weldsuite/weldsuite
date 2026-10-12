/**
 * Create a mailbox on a connected domain. Shared by the setup wizard and the
 * "New mailbox" dialog. Validates with the contract's `createReachMailboxSchema`;
 * a 402 PAYMENT_METHOD_REQUIRED turns into a prompt to add a card instead of a
 * dead end.
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { CreditCard, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  createReachMailboxSchema,
  reachMailboxTypeSchema,
  WELDREACH_INBOX_CURRENCY,
  WELDREACH_INBOX_PRICE_CENTS,
  type ReachDomain,
  type ReachMailbox,
} from '@weldsuite/app-api-client/schemas/reach';
import { useCreateReachMailbox } from '@/hooks/queries/use-reach-queries';
import { isPaymentMethodRequiredError, reachErrorMessage } from '@/lib/reach/errors';
import { useReachFormat } from '@/lib/reach/format';
import { createReachSchemaOptions } from '@/lib/reach/zod-error-map';
import { cn } from '@/lib/utils';
import { usePaymentMethodSetup } from './use-payment-method-setup';

type MailboxFormInput = z.input<typeof createReachMailboxSchema>;
type MailboxFormOutput = z.output<typeof createReachMailboxSchema>;

const MAILBOX_TYPES = reachMailboxTypeSchema.options;

interface CreateMailboxFormProps {
  /** Connected domains the mailbox can live on. */
  domains: ReachDomain[];
  defaultDomainId?: string;
  /** Where Stripe sends the browser back to after a payment method was added. */
  paymentReturnPath: '/weldreach/setup' | '/weldreach/mailboxes';
  paymentReturnQuery?: Record<string, string>;
  onCreated?: (mailbox: ReachMailbox) => void;
  onCancel?: () => void;
}

export function CreateMailboxForm({
  domains,
  defaultDomainId,
  paymentReturnPath,
  paymentReturnQuery,
  onCreated,
  onCancel,
}: Readonly<CreateMailboxFormProps>) {
  const t = useTranslations();
  const format = useReachFormat();
  const createMailbox = useCreateReachMailbox();
  const paymentSetup = usePaymentMethodSetup(paymentReturnPath, paymentReturnQuery);
  const [paymentRequired, setPaymentRequired] = useState(false);
  const schemaOptions = useMemo(() => createReachSchemaOptions(t), [t]);

  const form = useForm<MailboxFormInput, unknown, MailboxFormOutput>({
    resolver: zodResolver(createReachMailboxSchema, schemaOptions),
    defaultValues: {
      domainId: defaultDomainId ?? domains[0]?.id ?? '',
      localPart: '',
      firstName: '',
      lastName: '',
      signature: '',
      type: 'shared',
    },
  });

  const selectedDomain = domains.find((domain) => domain.id === form.watch('domainId'));
  const price = format.money(WELDREACH_INBOX_PRICE_CENTS, WELDREACH_INBOX_CURRENCY);
  const localPartError = form.formState.errors.localPart;

  const onSubmit = form.handleSubmit(async (values) => {
    setPaymentRequired(false);
    try {
      const res = await createMailbox.mutateAsync({ ...values, signature: values.signature?.trim() || undefined });
      toast.success(t('reach.mailboxes.create.created'));
      form.reset({ ...form.getValues(), localPart: '', firstName: '', lastName: '', signature: '' });
      onCreated?.(res.data);
    } catch (error) {
      if (isPaymentMethodRequiredError(error)) {
        setPaymentRequired(true);
        return;
      }
      toast.error(reachErrorMessage(error, t));
    }
  });

  if (domains.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('reach.mailboxes.create.noDomains')}</p>;
  }

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {paymentRequired && (
          <InfoBanner variant="warning" title={t('reach.mailboxes.create.paymentRequiredTitle')}>
            <p>{t('reach.mailboxes.create.paymentRequiredDescription')}</p>
            <Button
              type="button"
              size="sm"
              className="mt-2"
              disabled={paymentSetup.isPending}
              onClick={() => void paymentSetup.start()}
            >
              {paymentSetup.isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CreditCard className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('reach.mailboxes.create.addPayment')}
            </Button>
          </InfoBanner>
        )}

        <div className="grid items-start gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="domainId"
            render={({ field }) => (
              <FormItem className="min-w-0 grid-cols-[minmax(0,1fr)]">
                <FormLabel>{t('reach.mailboxes.create.domain')}</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('reach.mailboxes.create.domainPlaceholder')} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {domains.map((domain) => (
                      <SelectItem key={domain.id} value={domain.id}>
                        {domain.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="localPart"
            render={({ field }) => (
              <FormItem className="min-w-0 grid-cols-[minmax(0,1fr)]">
                <FormLabel>{t('reach.mailboxes.create.localPart')}</FormLabel>
                <div className="flex items-center gap-2">
                  <FormControl>
                    <Input
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder={t('reach.mailboxes.create.localPartPlaceholder')}
                      {...field}
                    />
                  </FormControl>
                  {selectedDomain && (
                    <span className="max-w-[50%] truncate text-sm text-muted-foreground">@{selectedDomain.name}</span>
                  )}
                </div>
                {localPartError && (
                  <p className="text-sm text-destructive">
                    {localPartError.type === 'invalid_string'
                      ? t('reach.validation.localPart')
                      : localPartError.message}
                  </p>
                )}
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t('reach.mailboxes.create.firstName')}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
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
                <FormLabel>{t('reach.mailboxes.create.lastName')}</FormLabel>
                <FormControl>
                  <Input autoComplete="off" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('reach.mailboxes.create.type')}</FormLabel>
              <RadioGroup value={field.value} onValueChange={field.onChange} className="grid gap-3 sm:grid-cols-2">
                {MAILBOX_TYPES.map((type) => {
                  const optionId = `reach-mailbox-type-${type}`;
                  return (
                    <Label
                      key={type}
                      htmlFor={optionId}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal',
                        field.value === type && 'border-primary bg-primary/5',
                      )}
                    >
                      <RadioGroupItem id={optionId} value={type} className="mt-0.5" />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">{t(`reach.mailboxes.create.types.${type}.label`)}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`reach.mailboxes.create.types.${type}.description`)}
                        </span>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="signature"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t('reach.mailboxes.create.signature')}</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder={t('reach.mailboxes.create.signaturePlaceholder')}
                  {...field}
                  value={field.value ?? ''}
                />
              </FormControl>
              <FormDescription>{t('reach.mailboxes.create.signatureHint')}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <p className="text-sm text-muted-foreground">{t('reach.mailboxes.create.price', { price })}</p>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {onCancel && (
            <Button type="button" variant="outline" disabled={createMailbox.isPending} onClick={onCancel}>
              {t('common.actions.cancel')}
            </Button>
          )}
          <Button type="submit" disabled={createMailbox.isPending}>
            {createMailbox.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {createMailbox.isPending ? t('reach.mailboxes.create.submitting') : t('reach.mailboxes.create.submit')}
          </Button>
        </div>
      </form>
    </Form>
  );
}
