/**
 * WeldHR settings — work locations: the places employees clock in at, and the
 * switch that makes clocking in or out depend on being at one of them.
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2, LocateFixed, MapPin } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { createHrWorkLocationSchema, type CreateHrWorkLocationInput } from '@weldsuite/app-api-client/schemas/weldhr';
import type { HrWorkLocation } from '@weldsuite/app-api-client/domains/weldhr';
import {
  useCreateHrWorkLocation,
  useDeleteHrWorkLocation,
  useHrPortalSettings,
  useHrWorkLocations,
  useUpdateHrPortalSettings,
  useUpdateHrWorkLocation,
} from '@/hooks/queries/use-weldhr-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import { emptyIcon } from '../../components/page-kit';
import { ErrorBanner, WarningNote, errorMessage } from '../../components/shared';
import { GeolocationError, getDevicePosition, type GeolocationFailure } from '../../lib/geolocation';

const DEFAULT_RADIUS_METERS = 100;

const LOCATION_FAILURE_MESSAGE: Record<GeolocationFailure, string> = {
  denied: 'weldhr.settings.workLocations.locationDenied',
  unavailable: 'weldhr.settings.workLocations.locationUnavailable',
  unsupported: 'weldhr.settings.workLocations.locationUnsupported',
};

/** A coordinate as the person typed or the device gave it: six decimals is about a tenth of a metre. */
function roundCoordinate(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function WorkLocationsTab() {
  const t = useTranslations();
  const { can } = usePermissions();
  const canManage = can('employees:manage');
  const { data: locations, isLoading, error } = useHrWorkLocations({ includeInactive: true });
  const { data: settings } = useHrPortalSettings();
  const updateSettings = useUpdateHrPortalSettings();
  const [search, setSearch] = useState('');
  const [dialogState, setDialogState] = useState<'create' | HrWorkLocation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrWorkLocation | null>(null);

  const requireLocation = settings?.clockInRequiresLocation ?? false;
  const hasActive = (locations ?? []).some((location) => location.isActive);

  const items = useMemo(() => {
    const all = locations ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return all;
    return all.filter((l) => l.name.toLowerCase().includes(query) || (l.address ?? '').toLowerCase().includes(query));
  }, [locations, search]);

  async function setRequireLocation(checked: boolean) {
    try {
      await updateSettings.mutateAsync({ clockInRequiresLocation: checked });
      toast.success(t('weldhr.settings.workLocations.requireSaved'));
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.settings.workLocations.requireFailed')));
    }
  }

  const groups: GroupConfig<HrWorkLocation>[] = [
    { id: 'active', label: t('weldhr.settings.workLocations.active'), sortOrder: 1, filter: (l) => l.isActive },
    { id: 'inactive', label: t('weldhr.settings.workLocations.inactive'), sortOrder: 2, filter: (l) => !l.isActive },
  ];

  const columns: ColumnDef<HrWorkLocation>[] = [
    {
      id: 'name',
      header: t('weldhr.settings.workLocations.name'),
      width: 'flex-1 min-w-[140px]',
      render: (l) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{l.name}</p>
          {l.address && <p className="truncate text-xs text-muted-foreground">{l.address}</p>}
        </div>
      ),
    },
    {
      id: 'coordinates',
      header: t('weldhr.settings.workLocations.coordinates'),
      width: 'hidden shrink-0 @2xl:block w-[170px]',
      render: (l) => (
        <span className="block truncate tabular-nums text-muted-foreground">
          {l.latitude.toFixed(5)}, {l.longitude.toFixed(5)}
        </span>
      ),
    },
    {
      id: 'radius',
      header: t('weldhr.settings.workLocations.radius'),
      width: 'shrink-0 w-[90px]',
      render: (l) => <span className="tabular-nums">{t('weldhr.settings.workLocations.radiusValue', { count: l.radiusMeters })}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-3 px-1">
        <div className="flex items-center justify-between gap-6 rounded-md border p-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('weldhr.settings.workLocations.requireTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('weldhr.settings.workLocations.requireDescription')}</p>
          </div>
          <Switch
            checked={requireLocation}
            disabled={!canManage || !settings || updateSettings.isPending}
            onCheckedChange={(checked) => void setRequireLocation(checked)}
            aria-label={t('weldhr.settings.workLocations.requireTitle')}
          />
        </div>
        {requireLocation && locations && !hasActive && <WarningNote>{t('weldhr.settings.workLocations.noActiveWarning')}</WarningNote>}
      </div>

      <PanelEntityList<HrWorkLocation>
        items={items}
        isLoading={isLoading}
        error={error}
        columns={columns}
        groups={groups}
        onEdit={canManage ? setDialogState : undefined}
        onDelete={canManage ? setDeleteTarget : undefined}
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder={t('weldhr.settings.workLocations.name')}
        createButton={canManage ? { label: t('weldhr.settings.workLocations.add'), onClick: () => setDialogState('create') } : undefined}
        emptyState={{
          icon: emptyIcon(MapPin),
          title: t('weldhr.settings.workLocations.emptyTitle'),
          description: t('weldhr.settings.workLocations.emptyDescription'),
          action: canManage ? { label: t('weldhr.settings.workLocations.add'), onClick: () => setDialogState('create') } : undefined,
        }}
      />

      {dialogState && <WorkLocationDialog location={dialogState === 'create' ? undefined : dialogState} onClose={() => setDialogState(null)} />}

      {deleteTarget && <DeleteWorkLocationDialog location={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </div>
  );
}

function WorkLocationDialog({ location, onClose }: Readonly<{ location?: HrWorkLocation; onClose: () => void }>) {
  const t = useTranslations();
  const createLocation = useCreateHrWorkLocation();
  const updateLocation = useUpdateHrWorkLocation();
  const [failure, setFailure] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const pending = createLocation.isPending || updateLocation.isPending;

  const form = useForm<CreateHrWorkLocationInput>({
    resolver: zodResolver(createHrWorkLocationSchema),
    mode: 'onChange',
    defaultValues: {
      name: location?.name ?? '',
      address: location?.address ?? '',
      // NaN is "not entered yet": the schema rejects it, and the inputs below show it empty.
      latitude: location?.latitude ?? Number.NaN,
      longitude: location?.longitude ?? Number.NaN,
      radiusMeters: location?.radiusMeters ?? DEFAULT_RADIUS_METERS,
      isActive: location?.isActive ?? true,
    },
  });
  const coordinatesInvalid = Boolean(form.formState.errors.latitude || form.formState.errors.longitude);

  async function fillFromDevice() {
    setFailure(null);
    setLocating(true);
    try {
      const position = await getDevicePosition();
      const options = { shouldValidate: true, shouldDirty: true } as const;
      form.setValue('latitude', roundCoordinate(position.latitude), options);
      form.setValue('longitude', roundCoordinate(position.longitude), options);
    } catch (err) {
      setFailure(err instanceof GeolocationError ? t(LOCATION_FAILURE_MESSAGE[err.reason]) : t('weldhr.settings.workLocations.locationUnavailable'));
    } finally {
      setLocating(false);
    }
  }

  async function onSubmit(values: CreateHrWorkLocationInput) {
    setFailure(null);
    const payload = { ...values, name: values.name.trim(), address: values.address?.trim() || null };
    try {
      if (location) {
        await updateLocation.mutateAsync({ id: location.id, ...payload });
      } else {
        await createLocation.mutateAsync(payload);
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.common.saveFailed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{location ? t('weldhr.settings.workLocations.editTitle') : t('weldhr.settings.workLocations.addTitle')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.settings.workLocations.name')}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={160} placeholder={t('weldhr.settings.workLocations.namePlaceholder')} autoFocus />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.settings.workLocations.address')}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ''} maxLength={500} />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="latitude"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.settings.workLocations.latitude')}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={-90}
                        max={90}
                        {...field}
                        value={Number.isNaN(field.value) ? '' : field.value}
                        aria-invalid={Boolean(form.formState.errors.latitude)}
                        onChange={(event) => field.onChange(event.target.value === '' ? Number.NaN : event.target.valueAsNumber)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="longitude"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.settings.workLocations.longitude')}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={-180}
                        max={180}
                        {...field}
                        value={Number.isNaN(field.value) ? '' : field.value}
                        aria-invalid={Boolean(form.formState.errors.longitude)}
                        onChange={(event) => field.onChange(event.target.value === '' ? Number.NaN : event.target.valueAsNumber)}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
            {coordinatesInvalid && <p className="-mt-2 text-xs text-destructive">{t('weldhr.settings.workLocations.coordinatesInvalid')}</p>}

            <Button type="button" variant="outline" size="sm" onClick={() => void fillFromDevice()} disabled={locating}>
              {locating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LocateFixed className="mr-2 h-4 w-4" />}
              {locating ? t('weldhr.settings.workLocations.locating') : t('weldhr.settings.workLocations.useMyLocation')}
            </Button>

            <FormField
              control={form.control}
              name="radiusMeters"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.settings.workLocations.radius')}</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={25}
                      max={5000}
                      className="w-32"
                      {...field}
                      value={field.value === undefined || Number.isNaN(field.value) ? '' : field.value}
                      aria-invalid={Boolean(form.formState.errors.radiusMeters)}
                      onChange={(event) => field.onChange(event.target.value === '' ? Number.NaN : event.target.valueAsNumber)}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">{t('weldhr.settings.workLocations.radiusHint')}</p>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <FormLabel>{t('weldhr.settings.workLocations.active')}</FormLabel>
                  <FormControl>
                    <Switch checked={field.value ?? true} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={!form.formState.isValid || pending}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteWorkLocationDialog({ location, onClose }: Readonly<{ location: HrWorkLocation; onClose: () => void }>) {
  const t = useTranslations();
  const deleteLocation = useDeleteHrWorkLocation();

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('weldhr.settings.workLocations.deleteTitle')}
      description={t('weldhr.settings.workLocations.deleteDescription', { name: location.name })}
      confirmLabel={t('weldhr.common.delete')}
      cancelLabel={t('weldhr.common.cancel')}
      variant="destructive"
      onConfirm={async () => {
        try {
          await deleteLocation.mutateAsync(location.id);
          onClose();
        } catch (err) {
          toast.error(errorMessage(err, t('weldhr.common.deleteFailed')));
        }
      }}
    />
  );
}
