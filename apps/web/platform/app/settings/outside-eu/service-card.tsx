import { useState } from 'react';
import { toast } from 'sonner';
import type { OutsideEuService } from '@weldsuite/app-api-client/schemas/outside-eu-services';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { errorMessage } from '@/app/agents/components/chat/labels';
import { useSwitchOutsideEuService } from '@/hooks/queries/use-outside-eu-queries';
import { useI18n } from '@/lib/i18n/provider';
import { countryName, fill, serviceData, labelOfUse, switchedOnText } from './outside-eu-view';
import { OutsideEuServiceConfirm } from './service-confirm';

/**
 * One service outside the EU: its "Leaves the EU" label, who runs it and
 * where, what data goes there, what uses it, and the switch. Switching on
 * asks for the acknowledgement first; switching off applies at once.
 */
export function OutsideEuServiceCard({
  service,
  canManage,
}: Readonly<{ service: OutsideEuService; canManage: boolean }>) {
  const { t } = useI18n();
  const to = t.settings.outsideEu;
  const update = useSwitchOutsideEuService();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const name = service.name;

  const save = (enabled: boolean) =>
    update
      .mutateAsync({
        service: service.id,
        input: enabled ? { enabled: true, acknowledgedOutsideEu: true } : { enabled: false },
      })
      .then(() => {
        toast.success(fill(enabled ? to.messages.enabled : to.messages.disabled, { service: name }));
      })
      .catch((err: unknown) => {
        toast.error(errorMessage(err, to.messages.failed));
        throw err;
      });

  const switched = switchedOnText(to, service, (iso) => new Date(iso).toLocaleDateString());

  return (
    <div className="rounded-xl border p-4" data-testid={`outside-eu-${service.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{name}</h3>
            <SoftBadge tone="warning">{to.leavesEu}</SoftBadge>
            <SoftBadge tone={service.enabled ? 'success' : 'neutral'}>
              {service.enabled ? to.statusOn : to.statusOff}
            </SoftBadge>
          </div>
          <p className="text-sm text-muted-foreground">
            {fill(to.where, { company: service.company, country: countryName(to, service.country) })}
          </p>
        </div>
        <Switch
          checked={service.enabled}
          disabled={!canManage || update.isPending}
          aria-label={fill(to.enableLabel, { service: name })}
          onCheckedChange={(on) => (on ? setConfirmOpen(true) : void save(false).catch(() => undefined))}
        />
      </div>

      <FieldGrid
        className="mt-4"
        fields={[
          { label: to.dataLabel, value: serviceData(to, service) },
          {
            label: to.usedBy,
            value: (
              <ul className="space-y-0.5">
                {service.uses.map((use) => (
                  <li key={`${use.module}:${use.key}`}>{labelOfUse(to, use)}</li>
                ))}
              </ul>
            ),
          },
        ]}
      />

      {switched && <p className="mt-3 text-xs text-muted-foreground">{switched}</p>}

      <OutsideEuServiceConfirm
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        service={service}
        onConfirm={async () => {
          try {
            await save(true);
            setConfirmOpen(false);
          } catch {
            // The toast is shown; keep the dialog open.
          }
        }}
      />
    </div>
  );
}
