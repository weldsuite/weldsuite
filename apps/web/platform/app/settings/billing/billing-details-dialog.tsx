import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { checkVatNumber, vatPlaceholderForCountry } from '@weldsuite/app-api-client/schemas/vat-number';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateWorkspaceSettings } from '@/hooks/queries/use-settings-queries';
import { CountrySelect } from '@/components/settings/country-select';
import { toBillingDetailsPayload, type BillingDetails } from './billing-details';

type I18n = ReturnType<typeof useI18n>;

/** Fields marked * are required; email and VAT must be well-formed. */
function getBillingDetailsSchema({ t, format }: Pick<I18n, 't' | 'format'>) {
  const v = t.settings.generalSettings.validation;
  const required = (message: string) => z.string().trim().min(1, message);
  return z
    .object({
      email: z.string().trim().min(1, v.emailRequired).email(v.emailRequired),
      company: required(v.companyNameRequired),
      addressLine1: required(v.addressRequired),
      addressLine2: z.string(),
      country: required(v.countryRequired),
      city: required(v.cityRequired),
      postalCode: required(v.postalCodeRequired),
      state: z.string(),
      vatNumber: z.string(),
    })
    .superRefine((data, ctx) => {
      const check = checkVatNumber(data.vatNumber, data.country);
      if (check.valid) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vatNumber'],
        message: check.example
          ? format(v.vatInvalid, { country: check.prefix, example: check.example })
          : v.taxIdInvalid,
      });
    });
}

interface BillingDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The persisted details; the form edits its own copy and only saves on submit. */
  details: BillingDetails;
}

export function BillingDetailsDialog({ open, onOpenChange, details }: Readonly<BillingDetailsDialogProps>) {
  const { t, format } = useI18n();
  const ts = t.settings.billing;
  const gs = t.settings.generalSettings;
  const updateMutation = useUpdateWorkspaceSettings();
  const isSaving = updateMutation.isPending;

  const form = useForm<BillingDetails>({
    resolver: zodResolver(getBillingDetailsSchema({ t, format })),
    defaultValues: details,
  });

  // Every time the dialog opens it starts from what is saved, so a cancelled
  // edit never lingers.
  useEffect(() => {
    if (open) form.reset(details);
  }, [open, details, form]);

  const country = form.watch('country');

  const onSubmit = async (values: BillingDetails) => {
    try {
      await updateMutation.mutateAsync(toBillingDetailsPayload(values));
      toast.success(ts.messages.updateSuccess);
      onOpenChange(false);
    } catch {
      toast.error(ts.messages.updateFailed);
    }
  };

  const requiredMark = <span className="text-destructive">*</span>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{ts.updateBillingDetails}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.billingEmail} {requiredMark}</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="email@example.com" autoComplete="email" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="company"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.companyName} {requiredMark}</FormLabel>
                  <FormControl>
                    <Input autoComplete="organization" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="addressLine1"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.addressLine1} {requiredMark}</FormLabel>
                  <FormControl>
                    <Input autoComplete="address-line1" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="addressLine2"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{ts.addressLine2}</FormLabel>
                  <FormControl>
                    <Input autoComplete="address-line2" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.country} {requiredMark}</FormLabel>
                    <FormControl>
                      <CountrySelect
                        value={field.value}
                        onChange={(code) => field.onChange(code)}
                        onBlur={field.onBlur}
                        placeholder={gs.selectCountry}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{gs.city} {requiredMark}</FormLabel>
                    <FormControl>
                      <Input autoComplete="address-level2" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="postalCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{gs.postalCode} {requiredMark}</FormLabel>
                    <FormControl>
                      <Input autoComplete="postal-code" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="state"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.state}</FormLabel>
                    <FormControl>
                      <Input autoComplete="address-level1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="vatNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{ts.vatNumber}</FormLabel>
                    <FormControl>
                      <Input placeholder={vatPlaceholderForCountry(country)} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2 sm:gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    {t.settings.actions.saving}
                  </>
                ) : (
                  ts.updateBillingDetails
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
