import { useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Link, useParams } from '@tanstack/react-router';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import { AddressFields } from '@/components/address/address-fields';
import { cleanPostalAddress, toPostalAddressFormValue } from '@/components/address/postal-address';
import {
  useAccountingEntity,
  useAccountingJurisdictions,
  useUpdateAccountingEntity,
} from '@/hooks/queries/use-accounting-queries';
import type { AccountingEntity, UpdateAccountingEntityInput } from '@/lib/api/domains/weldbooks';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { DEFAULT_TERMINOLOGY, usesIban } from '@/lib/weldbooks/jurisdiction';
import { useTerminologyLabels } from '@/lib/weldbooks/use-jurisdiction';
import { entityTypesFor } from '@/lib/weldbooks/entity-types';
import { useI18n } from '@/lib/i18n/provider';
import { LockDatesCard } from './components/lock-dates-card';
import { LockExceptionsCard } from './components/lock-exceptions-card';

const NO_ENTITY_TYPE = '__none__';

const addressSchema = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

function createEntitySchema(messages: { nameRequired: string; invalidEmail: string }) {
  return z.object({
    name: z.string().trim().min(1, messages.nameRequired),
    legalName: z.string().optional(),
    entityType: z.string(),
    fiscalYearStart: z.string(),
    address: addressSchema,
    email: z.string().trim().email(messages.invalidEmail).optional().or(z.literal('')),
    phone: z.string().optional(),
    website: z.string().optional(),
    bankName: z.string().optional(),
    iban: z.string().optional(),
    bic: z.string().optional(),
    accountNumber: z.string().optional(),
    routingNumber: z.string().optional(),
    taxId: z.string().optional(),
    registrationNumber: z.string().optional(),
  });
}

type EntityFormValues = z.infer<ReturnType<typeof createEntitySchema>>;

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** Only the non-blank values, so a cleared field is dropped from the object. */
function compact<T extends Record<string, string | undefined>>(record: T): Partial<Record<keyof T, string>> {
  const out: Partial<Record<keyof T, string>> = {};
  for (const [key, value] of Object.entries(record) as Array<[keyof T, string | undefined]>) {
    const v = value?.trim();
    if (v) out[key] = v;
  }
  return out;
}

function toFormValues(entity: AccountingEntity, taxIdField: 'vatNumber' | 'einOrSsn'): EntityFormValues {
  const ids = entity.taxIdentifiers ?? {};
  return {
    name: entity.name ?? '',
    legalName: entity.legalName ?? '',
    entityType: entity.entityType || NO_ENTITY_TYPE,
    fiscalYearStart: String(entity.fiscalYearStart ?? 1),
    address: toPostalAddressFormValue(normalizeAccountingAddress(entity.address)),
    email: entity.contact?.email ?? '',
    phone: entity.contact?.phone ?? '',
    website: entity.contact?.website ?? '',
    bankName: entity.bankDetails?.bankName ?? '',
    iban: entity.bankDetails?.iban ?? '',
    bic: entity.bankDetails?.bic ?? '',
    accountNumber: entity.bankDetails?.accountNumber ?? '',
    routingNumber: entity.bankDetails?.routingNumber ?? '',
    taxId: ids[taxIdField] ?? '',
    registrationNumber: ids.registrationNumber ?? '',
  };
}

export default function EditEntityPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { t, language } = useI18n();
  const te = t.accounting.entityEdit;
  const entityQuery = useAccountingEntity(id);
  const { data: jurisdictions } = useAccountingJurisdictions();
  const canUpdate = useCan('entities:update');

  const entity = entityQuery.data;
  const jurisdictionCode = entity?.jurisdictionCode?.toUpperCase() ?? null;
  const jurisdiction = jurisdictions?.find((j) => j.code.toUpperCase() === jurisdictionCode) ?? null;
  const terminology = jurisdiction?.terminology ?? DEFAULT_TERMINOLOGY;
  const labels = useTerminologyLabels(terminology);

  if (entityQuery.isLoading) return <PageLoader fullScreen={false} />;

  if (entityQuery.isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" aria-hidden />
        <p className="text-sm text-muted-foreground">{te.loadError}</p>
        <Button variant="outline" size="sm" onClick={() => void entityQuery.refetch()}>
          {t.accounting.layout.retry}
        </Button>
      </div>
    );
  }

  if (!entity) {
    return (
      <div className="p-6 space-y-2">
        <p className="text-muted-foreground">{te.notFound}</p>
        <Link to="/weldbooks/entities">
          <Button variant="link" className="px-0">{te.back}</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6">
      <div className="flex items-start gap-3">
        <Link to="/weldbooks/entities">
          <Button variant="ghost" size="icon" aria-label={te.back}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold">{te.title.replace('{name}', entity.name)}</h1>
          <p className="text-sm text-muted-foreground">{te.description}</p>
        </div>
      </div>

      {!canUpdate && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">{te.readOnly}</p>
      )}

      <EntityDetailsForm
        key={entity.id}
        entity={entity}
        canUpdate={canUpdate}
        language={language || 'en'}
        taxIdField={terminology.taxId === 'ein' ? 'einOrSsn' : 'vatNumber'}
        taxIdLabel={labels.taxId}
        taxIdIsEin={terminology.taxId === 'ein'}
        registrationLabel={labels.registrationId}
        jurisdictionName={jurisdiction ? `${jurisdiction.name} (${jurisdiction.code})` : entity.jurisdictionCode}
      />

      <LockDatesCard entity={entity} canUpdate={canUpdate} />
      <LockExceptionsCard entityId={entity.id} canUpdate={canUpdate} />
    </div>
  );
}

interface EntityDetailsFormProps {
  entity: AccountingEntity;
  canUpdate: boolean;
  language: string;
  taxIdField: 'vatNumber' | 'einOrSsn';
  taxIdLabel: string;
  taxIdIsEin: boolean;
  registrationLabel: string;
  jurisdictionName: string;
}

function EntityDetailsForm({
  entity,
  canUpdate,
  language,
  taxIdField,
  taxIdLabel,
  taxIdIsEin,
  registrationLabel,
  jurisdictionName,
}: Readonly<EntityDetailsFormProps>) {
  const { t } = useI18n();
  const te = t.accounting.entityEdit;
  const entityTypeLabels = t.accounting.entityTypes;
  const updateEntity = useUpdateAccountingEntity();
  const schema = useMemo(
    () => createEntitySchema({ nameRequired: te.nameRequired, invalidEmail: te.invalidEmail }),
    [te.nameRequired, te.invalidEmail],
  );
  const initial = useMemo(() => toFormValues(entity, taxIdField), [entity, taxIdField]);

  const form = useForm<EntityFormValues>({
    resolver: zodResolver(schema),
    values: initial,
    resetOptions: { keepDirtyValues: true },
  });

  const ibanBanking = usesIban(entity.jurisdictionCode);
  const isUs = entity.jurisdictionCode?.toUpperCase() === 'US';
  const entityTypes = entityTypesFor(entity.jurisdictionCode, entity.entityType);
  const months = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(language, { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => ({
      value: String(i + 1),
      label: fmt.format(new Date(Date.UTC(2026, i, 1))),
    }));
  }, [language]);
  const disabled = !canUpdate || updateEntity.isPending;

  const submit = async (values: EntityFormValues) => {
    const ids = entity.taxIdentifiers ?? {};
    // Send a tax identifier only when it changed: the server validates every
    // identifier it receives against the jurisdiction (an untouched empty
    // GSTIN would fail), and a cleared one is sent as '' to remove it.
    const taxIdentifiers: NonNullable<UpdateAccountingEntityInput['taxIdentifiers']> = {};
    if (trimmed(values.taxId) !== (ids[taxIdField] ?? '')) taxIdentifiers[taxIdField] = trimmed(values.taxId);
    if (trimmed(values.registrationNumber) !== (ids.registrationNumber ?? '')) {
      taxIdentifiers.registrationNumber = trimmed(values.registrationNumber);
    }

    const payload: UpdateAccountingEntityInput = {
      name: values.name.trim(),
      legalName: trimmed(values.legalName),
      fiscalYearStart: Number(values.fiscalYearStart),
      address: cleanPostalAddress(values.address) ?? {},
      contact: compact({ email: values.email, phone: values.phone, website: values.website }),
      bankDetails: ibanBanking
        ? compact({
            bankName: values.bankName,
            iban: values.iban?.replace(/\s+/g, '').toUpperCase(),
            bic: values.bic?.toUpperCase(),
            accountNumber: entity.bankDetails?.accountNumber,
            routingNumber: entity.bankDetails?.routingNumber,
          })
        : compact({
            bankName: values.bankName,
            accountNumber: values.accountNumber,
            routingNumber: values.routingNumber,
            iban: entity.bankDetails?.iban,
            bic: entity.bankDetails?.bic,
          }),
    };
    if (values.entityType !== NO_ENTITY_TYPE) payload.entityType = values.entityType;
    if (Object.keys(taxIdentifiers).length > 0) payload.taxIdentifiers = taxIdentifiers;

    try {
      await updateEntity.mutateAsync({ id: entity.id, data: payload });
      toast.success(te.saved);
    } catch (err) {
      // e.g. an invalid VAT number / GSTIN / EIN for this jurisdiction.
      toast.error(te.saveFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const errors = form.formState.errors;

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{te.general}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="entity-name">{te.name} *</Label>
            <Input id="entity-name" disabled={disabled} aria-describedby="entity-name-help" {...form.register('name')} />
            <p id="entity-name-help" className="text-xs text-muted-foreground">{te.nameHelp}</p>
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="entity-legalName">{te.legalName}</Label>
            <Input
              id="entity-legalName"
              disabled={disabled}
              aria-describedby="entity-legalName-help"
              {...form.register('legalName')}
            />
            <p id="entity-legalName-help" className="text-xs text-muted-foreground">{te.legalNameHelp}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="entity-type">{te.entityType}</Label>
            <Controller
              control={form.control}
              name="entityType"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                  <SelectTrigger id="entity-type">
                    <SelectValue placeholder={te.selectEntityType} />
                  </SelectTrigger>
                  <SelectContent>
                    {field.value === NO_ENTITY_TYPE && (
                      <SelectItem value={NO_ENTITY_TYPE}>{te.selectEntityType}</SelectItem>
                    )}
                    {entityTypes.map((type) => (
                      <SelectItem key={type} value={type}>
                        {entityTypeLabels[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="entity-fiscalYearStart">{te.fiscalYearStart}</Label>
            <Controller
              control={form.control}
              name="fiscalYearStart"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
                  <SelectTrigger id="entity-fiscalYearStart">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((month) => (
                      <SelectItem key={month.value} value={month.value}>
                        {month.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{te.jurisdiction}</p>
            <p className="text-sm text-muted-foreground">{jurisdictionName}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{te.baseCurrency}</p>
            <p className="text-sm text-muted-foreground">{entity.baseCurrency}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{te.address}</CardTitle>
        </CardHeader>
        <CardContent>
          <Controller
            control={form.control}
            name="address"
            render={({ field }) => (
              <AddressFields idPrefix="entity-address" value={field.value} onChange={field.onChange} disabled={disabled} />
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{te.contact}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="entity-email">{te.email}</Label>
            <Input id="entity-email" type="email" disabled={disabled} {...form.register('email')} />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="entity-phone">{te.phone}</Label>
            <Input id="entity-phone" type="tel" disabled={disabled} {...form.register('phone')} />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="entity-website">{te.website}</Label>
            <Input id="entity-website" type="url" disabled={disabled} {...form.register('website')} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{te.taxIdentifiers}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="entity-taxId">{taxIdLabel}</Label>
            <Input
              id="entity-taxId"
              disabled={disabled}
              aria-describedby={taxIdIsEin ? 'entity-taxId-help' : undefined}
              {...form.register('taxId')}
            />
            {taxIdIsEin && (
              <p id="entity-taxId-help" className="text-xs text-muted-foreground">{te.einHelp}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="entity-registrationNumber">{registrationLabel}</Label>
            <Input id="entity-registrationNumber" disabled={disabled} {...form.register('registrationNumber')} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{te.bankDetails}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="entity-bankName">{te.bankName}</Label>
            <Input id="entity-bankName" disabled={disabled} {...form.register('bankName')} />
          </div>
          {ibanBanking ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="entity-iban">{te.iban}</Label>
                <Input id="entity-iban" disabled={disabled} {...form.register('iban')} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="entity-bic">{te.bic}</Label>
                <Input id="entity-bic" disabled={disabled} {...form.register('bic')} />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="entity-accountNumber">{te.accountNumber}</Label>
                <Input
                  id="entity-accountNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={disabled}
                  {...form.register('accountNumber')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="entity-routingNumber">{te.routingNumber}</Label>
                <Input
                  id="entity-routingNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={disabled}
                  aria-describedby={isUs ? 'entity-routingNumber-help' : undefined}
                  {...form.register('routingNumber')}
                />
                {isUs && (
                  <p id="entity-routingNumber-help" className="text-xs text-muted-foreground">
                    {te.routingNumberHelp}
                  </p>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {canUpdate && (
        <div className="flex justify-end">
          <Button type="submit" disabled={updateEntity.isPending}>
            {updateEntity.isPending ? te.saving : te.save}
          </Button>
        </div>
      )}
    </form>
  );
}
