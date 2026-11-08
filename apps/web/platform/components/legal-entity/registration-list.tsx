/**
 * The registrations of one legal entity (VAT, company, payroll tax, US state
 * accounts…): a list with add, edit and delete. Self-contained: it reads and
 * writes through the legal-entity hooks, so WeldBooks and WeldHR can drop it
 * next to any entity.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import {
  LEGAL_ENTITY_REGISTRATION_TYPES,
  normalizeRegistrationNumber,
  registrationNumberError,
  type LegalEntityRegistration,
  type LegalEntityRegistrationType,
} from '@weldsuite/app-api-client/schemas/legal-entities';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorBanner, ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { CountrySelect } from '@/components/settings/country-select';
import { US_STATES } from '@/components/address/us-states';
import {
  useDeleteRegistration,
  useLegalEntityRegistrations,
  useSaveRegistration,
} from '@/hooks/queries/use-legal-entities-queries';
import { useI18n } from '@/lib/i18n/provider';

/** Registration types that belong to one US state. */
const REGION_TYPES: readonly LegalEntityRegistrationType[] = ['us_state_withholding', 'us_state_unemployment'];

export function registrationNeedsRegion(type: LegalEntityRegistrationType): boolean {
  return REGION_TYPES.includes(type);
}

const formSchema = z.object({
  type: z.enum(LEGAL_ENTITY_REGISTRATION_TYPES),
  number: z.string(),
  country: z.string(),
  region: z.string(),
  label: z.string().max(120),
  isPrimary: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

function emptyValues(jurisdictionCode: string): FormValues {
  return { type: 'vat', number: '', country: jurisdictionCode, region: '', label: '', isPrimary: false };
}

interface RegistrationListProps {
  entityId: string;
  /** The entity's country of registration: the default country of a new registration. */
  jurisdictionCode: string;
  /** Shows the add, edit and delete controls (`legal_entities:update`). */
  canEdit: boolean;
}

export function RegistrationList({ entityId, jurisdictionCode, canEdit }: Readonly<RegistrationListProps>) {
  const { t } = useI18n();
  const tr = t.settings.legalEntities.registrations;
  const { data, isLoading, error, refetch } = useLegalEntityRegistrations(entityId);
  const remove = useDeleteRegistration(entityId);
  const [editing, setEditing] = useState<LegalEntityRegistration | 'new' | null>(null);
  const [deleting, setDeleting] = useState<LegalEntityRegistration | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const typeLabels = tr.types as Record<string, string>;

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(tr.deleted);
      setDeleting(null);
      setDeleteError(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : tr.failed);
    }
  }

  let body: ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} className="min-h-[120px] pb-0" />;
  } else if (error) {
    body = <ErrorState message={tr.loadFailed} onRetry={() => refetch()} />;
  } else if (!data || data.length === 0) {
    body = <EmptyText>{tr.empty}</EmptyText>;
  } else {
    body = (
      <ul className="divide-y rounded-md border">
        {data.map((registration) => (
          <li key={registration.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{typeLabels[registration.type] ?? registration.type}</span>
                {registration.isPrimary && <SoftBadge tone="success">{tr.primaryBadge}</SoftBadge>}
              </div>
              <p className="break-all font-mono text-sm">{registration.number}</p>
              <p className="text-xs text-muted-foreground">
                {[registration.country, registration.region, registration.label].filter(Boolean).join(' · ')}
              </p>
            </div>
            {canEdit && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={tr.editTitle} onClick={() => setEditing(registration)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.settings.legalEntities.detail.delete}
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(registration);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <SectionCard
      title={tr.title}
      description={tr.description}
      action={
        canEdit ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="mr-2 h-4 w-4" />
            {tr.add}
          </Button>
        ) : undefined
      }
    >
      {body}
      <RegistrationDialog
        entityId={entityId}
        jurisdictionCode={jurisdictionCode}
        registration={editing === 'new' ? null : editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={tr.deleteTitle}
        description={
          <>
            {tr.deleteDescription}
            {deleteError && <ErrorBanner error={deleteError} className="mt-3" />}
          </>
        }
        confirmLabel={t.settings.legalEntities.detail.delete}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </SectionCard>
  );
}

interface RegistrationDialogProps {
  entityId: string;
  jurisdictionCode: string;
  /** The registration being edited; null adds a new one. */
  registration: LegalEntityRegistration | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function RegistrationDialog({
  entityId,
  jurisdictionCode,
  registration,
  open,
  onOpenChange,
}: Readonly<RegistrationDialogProps>) {
  const { t } = useI18n();
  const tr = t.settings.legalEntities.registrations;
  const save = useSaveRegistration(entityId);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const typeLabels = tr.types as Record<string, string>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: emptyValues(jurisdictionCode),
  });

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    form.reset(
      registration
        ? {
            type: registration.type,
            number: registration.number,
            country: registration.country ?? '',
            region: registration.region ?? '',
            label: registration.label ?? '',
            isPrimary: registration.isPrimary,
          }
        : emptyValues(jurisdictionCode),
    );
  }, [open, registration, jurisdictionCode, form]);

  const type = form.watch('type');

  async function onSubmit(values: FormValues) {
    form.clearErrors();
    const normalized = normalizeRegistrationNumber(values.type, values.number);
    if (!normalized) {
      form.setError('number', { message: tr.numberRequired });
      return;
    }
    if (registrationNumberError(values.type, normalized)) {
      const messages: Record<string, string> = tr.invalidNumber;
      form.setError('number', { message: messages[values.type] ?? tr.invalidNumber.other });
      return;
    }
    const needsRegion = registrationNeedsRegion(values.type);
    if (needsRegion && !values.region) {
      form.setError('region', { message: tr.regionRequired });
      return;
    }
    const country = needsRegion ? 'US' : values.country || null;
    const region = needsRegion ? values.region : null;
    const label = values.label.trim() || null;
    try {
      if (registration) {
        await save.mutateAsync({
          id: registration.id,
          update: { number: normalized, country, region, label, isPrimary: values.isPrimary },
        });
      } else {
        await save.mutateAsync({
          create: { type: values.type, number: normalized, country, region, label, isPrimary: values.isPrimary },
        });
      }
      toast.success(tr.saved);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : tr.failed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{registration ? tr.editTitle : tr.addTitle}</DialogTitle>
          <DialogDescription>{tr.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={submitError} onDismiss={() => setSubmitError(null)} />
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr.type}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange} disabled={registration !== null}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {LEGAL_ENTITY_REGISTRATION_TYPES.map((value) => (
                        <SelectItem key={value} value={value}>
                          {typeLabels[value] ?? value}
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
              name="number"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr.number}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {registrationNeedsRegion(type) ? (
              <FormField
                control={form.control}
                name="region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tr.region}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={tr.regionPlaceholder} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {US_STATES.map((state) => (
                          <SelectItem key={state.code} value={state.code}>
                            {state.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tr.country}</FormLabel>
                    <FormControl>
                      <CountrySelect value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr.label}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={tr.labelPlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="isPrimary"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4 space-y-0">
                  <FormLabel>{tr.primary}</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {t.common.actions.save}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
