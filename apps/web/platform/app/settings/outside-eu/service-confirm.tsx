import { useEffect, useId, useState } from 'react';
import type { OutsideEuService } from '@weldsuite/app-api-client/schemas/outside-eu-services';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { countryName, fill, serviceData } from './outside-eu-view';

/**
 * What switching on a service outside the EU means (what leaves the EU, to
 * whom, when), and the acknowledgement the API insists on
 * (`acknowledgedOutsideEu`), as for AI providers (`settings/ai/outside-eu-confirm.tsx`).
 * Confirm stays off until the box is ticked.
 */
export function OutsideEuServiceConfirm({
  open,
  onOpenChange,
  service,
  onConfirm,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: OutsideEuService;
  onConfirm: () => void | Promise<void>;
}>) {
  const { t } = useI18n();
  const to = t.settings.outsideEu;
  const tc = to.confirm;
  const [acknowledged, setAcknowledged] = useState(false);
  const checkboxId = useId();
  const values = {
    service: service.name,
    company: service.company,
    country: countryName(to, service.country),
    data: serviceData(to, service),
  };

  // A fresh dialog never starts ticked.
  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={fill(tc.title, values)}
      confirmLabel={tc.confirm}
      cancelLabel={tc.cancel}
      confirmDisabled={!acknowledged}
      onConfirm={onConfirm}
      description={
        <span className="block space-y-3 text-left">
          <span className="block">{fill(tc.description, values)}</span>
          <span className="block space-y-1.5">
            {[tc.what, tc.where, tc.when, tc.record].map((line) => (
              <span key={line} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{fill(line, values)}</span>
              </span>
            ))}
          </span>
          <span className="flex items-start gap-2 text-foreground">
            <Checkbox
              id={checkboxId}
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              className="mt-0.5"
            />
            <label htmlFor={checkboxId} className="text-sm">
              {fill(tc.acknowledge, values)}
            </label>
          </span>
        </span>
      }
    />
  );
}
