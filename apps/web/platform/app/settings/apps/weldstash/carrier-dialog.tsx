/**
 * Connect or edit a carrier account: carrier, contract, the carrier's
 * credential fields, sandbox, label format, name, default, and optional sender
 * and return addresses. The backend tests the credentials before it saves.
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@weldsuite/ui/components/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel } from '@weldsuite/ui/components/form';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Switch } from '@weldsuite/ui/components/switch';
import type {
  AddressInput,
  CarrierAccount,
  CarrierCatalogEntry,
  CarrierCode,
  CarrierSettings,
  LabelFormat,
} from '@weldsuite/app-api-client/schemas/shipping';
import { useCreateCarrier, useUpdateCarrier } from '@/hooks/queries/use-shipping-queries';
import { getTranslations } from '@/lib/i18n';
import { AddressFields, SelectField, TextField } from '@/app/weldstash/shipping/components/form-fields';
import { ShippingErrorNotice } from '@/app/weldstash/shipping/components/shipping-error-notice';
import { shippingErrorInfo } from '@/app/weldstash/shipping/lib/errors';
import { addressToValues, addressValuesSchema, valuesToAddress, type AddressValues } from '@/app/weldstash/shipping/lib/labels-form';

interface CarrierFormValues {
  code: CarrierCode;
  contract: 'own' | 'weldsuite';
  credentials: Record<string, string>;
  sandbox: boolean;
  labelFormat: LabelFormat;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  senderAddress: AddressValues;
  returnAddress: AddressValues;
}

const MASK = '•';

/** A secret that came back masked (`••••abcd`) is the stored one, not something to send. */
function isMasked(value: string): boolean {
  return value.startsWith(MASK);
}

function hasAddress(values: AddressValues): boolean {
  return Object.values(values).some((v) => v.trim() !== '');
}

function toAddress(values: AddressValues): AddressInput | null {
  return hasAddress(values) ? valuesToAddress(values) : null;
}

function initialValues(carrier: CarrierAccount | undefined, entry: CarrierCatalogEntry | undefined): CarrierFormValues {
  const credentials: Record<string, string> = {};
  for (const field of entry?.credentialFields ?? []) {
    // A saved secret is never shown: leave it empty to keep it.
    credentials[field.key] = field.secret ? '' : (carrier?.credentials[field.key] ?? '');
  }
  return {
    code: carrier?.code ?? entry?.code ?? 'postnl',
    contract: carrier?.contract === 'weldsuite' ? 'weldsuite' : 'own',
    credentials,
    sandbox: carrier?.settings.sandbox ?? false,
    labelFormat: carrier?.settings.labelFormat ?? entry?.labelFormats[0] ?? 'pdf_a6',
    name: carrier?.name ?? '',
    isDefault: carrier?.isDefault ?? false,
    isActive: carrier?.isActive ?? true,
    senderAddress: addressToValues(carrier?.settings.senderAddress),
    returnAddress: addressToValues(carrier?.settings.returnAddress),
  };
}

interface CarrierDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: CarrierCatalogEntry[];
  /** Set to edit an account; unset connects a new one. */
  carrier?: CarrierAccount;
}

export function CarrierDialog({ open, onOpenChange, catalog, carrier }: Readonly<CarrierDialogProps>) {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.carriers.dialog;
  const editing = !!carrier;
  const create = useCreateCarrier();
  const update = useUpdateCarrier();
  const [addressesOpen, setAddressesOpen] = useState(false);

  const schema = useMemo(
    () =>
      z
        .object({
          code: z.enum(['postnl', 'dhl_parcel_nl']),
          contract: z.enum(['own', 'weldsuite']),
          credentials: z.record(z.string()),
          sandbox: z.boolean(),
          labelFormat: z.enum(['pdf_a6', 'pdf_a4', 'zpl']),
          name: z.string().trim().max(120),
          isDefault: z.boolean(),
          isActive: z.boolean(),
          senderAddress: addressValuesSchema,
          returnAddress: addressValuesSchema,
        })
        .superRefine((values, ctx) => {
          if (values.contract !== 'own') return;
          const entry = catalog.find((c) => c.code === values.code);
          for (const field of entry?.credentialFields ?? []) {
            // Editing keeps a saved secret, so it may stay empty.
            const optionalNow = !field.required || (editing && field.secret);
            if (!optionalNow && !(values.credentials[field.key] ?? '').trim()) {
              ctx.addIssue({ code: 'custom', path: ['credentials', field.key], message: t.required });
            }
          }
        }),
    [catalog, editing, t.required],
  );

  const form = useForm<CarrierFormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialValues(carrier, catalog.find((c) => c.code === carrier?.code) ?? catalog[0]),
  });
  const code = useWatch({ control: form.control, name: 'code' });
  const contract = useWatch({ control: form.control, name: 'contract' });
  const entry = catalog.find((c) => c.code === code);
  // A carrier offers its own label formats.
  useEffect(() => {
    if (entry && !entry.labelFormats.includes(form.getValues('labelFormat'))) form.setValue('labelFormat', entry.labelFormats[0] ?? 'pdf_a6');
  }, [entry, form]);
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const errorCode = error ? shippingErrorInfo(error, ts.errors, ts.errors.generic).code : null;

  const save = async (values: CarrierFormValues, skipTest: boolean) => {
    const credentials: Record<string, string> = {};
    if (values.contract === 'own') {
      for (const field of entry?.credentialFields ?? []) {
        const value = (values.credentials[field.key] ?? '').trim();
        if (value && !isMasked(value)) credentials[field.key] = value;
      }
    }
    const settings: CarrierSettings = {
      sandbox: values.sandbox,
      labelFormat: values.labelFormat,
      senderAddress: toAddress(values.senderAddress),
      returnAddress: toAddress(values.returnAddress),
    };
    const common = {
      name: values.name.trim() || undefined,
      contract: values.contract,
      credentials: values.contract === 'own' ? credentials : undefined,
      settings,
      isDefault: values.isDefault,
      isActive: values.isActive,
      skipTest: skipTest || undefined,
    };
    try {
      if (carrier) await update.mutateAsync({ id: carrier.id, data: common });
      else await create.mutateAsync({ code: values.code, ...common });
      toast.success(ts.carriers.saved);
      onOpenChange(false);
    } catch {
      // The notice in the dialog shows what the backend said.
    }
  };

  const onSubmit = form.handleSubmit((values) => save(values, false));

  const carrierOptions = catalog.map((c) => ({ value: c.code, label: c.name }));
  const formatOptions = (entry?.labelFormats ?? []).map((f) => ({ value: f, label: ts.labelFormats[f] }));
  const credentialLabels = ts.credentialFields as Record<string, string>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? t.editTitle : t.createTitle}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <SelectField
              control={form.control}
              name="code"
              label={t.carrier}
              options={carrierOptions}
              disabled={editing}
              required
            />

            {entry?.weldsuiteContract ? (
              <FormField
                control={form.control}
                name="contract"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.contract}</FormLabel>
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="gap-2">
                        {(['own', 'weldsuite'] as const).map((value) => {
                          const id = `carrier-contract-${value}`;
                          return (
                            <div key={value} className="flex items-start gap-3 rounded-md border p-3">
                              <RadioGroupItem id={id} value={value} className="mt-1" />
                              <label htmlFor={id} className="block flex-1 cursor-pointer text-sm">
                                <span className="font-medium">{value === 'own' ? t.contractOwn : t.contractWeldsuite}</span>
                                <span className="block text-muted-foreground">
                                  {value === 'own' ? t.contractOwnHint : t.contractWeldsuiteHint}
                                </span>
                              </label>
                            </div>
                          );
                        })}
                      </RadioGroup>
                    </FormControl>
                  </FormItem>
                )}
              />
            ) : null}

            {contract === 'own' && entry ? (
              <fieldset className="space-y-3 rounded-lg border p-4">
                <legend className="px-1 text-sm font-medium">{t.credentials}</legend>
                {entry.credentialFields.map((field) => (
                  <TextField
                    key={`${entry.code}-${field.key}`}
                    control={form.control}
                    name={`credentials.${field.key}`}
                    label={`${credentialLabels[field.key] ?? field.key}${field.required ? '' : ` (${t.optional})`}`}
                    type={field.secret ? 'password' : 'text'}
                    autoComplete={field.secret ? 'off' : undefined}
                    required={field.required && !(editing && field.secret)}
                    placeholder={editing && field.secret ? (carrier?.credentials[field.key] ?? '') : undefined}
                    description={editing && field.secret ? t.keepSecretHint : undefined}
                  />
                ))}
              </fieldset>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <TextField control={form.control} name="name" label={t.name} placeholder={t.namePlaceholder} />
              <SelectField control={form.control} name="labelFormat" label={t.labelFormat} options={formatOptions} />
            </div>

            <FormField
              control={form.control}
              name="sandbox"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>{t.sandbox}</FormLabel>
                    <FormDescription>{t.sandboxHint}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="isDefault"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4 rounded-md border p-3">
                    <FormLabel>{t.makeDefault}</FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-4 rounded-md border p-3">
                    <FormLabel>{t.active}</FormLabel>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            <Collapsible open={addressesOpen} onOpenChange={setAddressesOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="-ml-2">
                  <ChevronDown className={`size-4 transition-transform ${addressesOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                  {t.senderAddress} / {t.returnAddress}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">{t.addressHint}</p>
                <fieldset className="space-y-3">
                  <legend className="mb-2 text-sm font-medium">{t.senderAddress}</legend>
                  <AddressFields control={form.control} prefix="senderAddress" withContact />
                </fieldset>
                <fieldset className="space-y-3">
                  <legend className="mb-2 text-sm font-medium">{t.returnAddress}</legend>
                  <AddressFields control={form.control} prefix="returnAddress" withContact />
                </fieldset>
              </CollapsibleContent>
            </Collapsible>

            {error ? <ShippingErrorNotice error={error} title={t.errorTitle} /> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {getTranslations('weldstash').shipping.labels.cancel}
              </Button>
              {errorCode === 'CARRIER_UNAVAILABLE' ? (
                <Button type="button" variant="outline" disabled={pending} onClick={() => void form.handleSubmit((values) => save(values, true))()}>
                  {t.saveWithoutTest}
                </Button>
              ) : null}
              <Button type="submit" disabled={pending}>
                {pending ? <InlineSpinner /> : null}
                {pending ? t.saving : t.save}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
