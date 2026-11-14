import { useEffect, useId, useState } from 'react';
import type { AiProviderId } from '@weldsuite/app-api-client/schemas/ai-settings';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useAiProviderName } from '@/components/ai/ai-meta-badge';
import { useI18n } from '@/lib/i18n/provider';

/**
 * What switching on a provider outside the EU means (what leaves the EU, to
 * whom), and the acknowledgement the API insists on (`acknowledgedOutsideEu`).
 * Confirm stays off until the box is ticked.
 */
export function OutsideEuConfirm({
  open,
  onOpenChange,
  provider,
  onConfirm,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: AiProviderId;
  onConfirm: () => void | Promise<void>;
}>) {
  const { t } = useI18n();
  const tc = t.settings.ai.confirm;
  const name = useAiProviderName()(provider);
  const company = (t.settings.ai.companies as Record<string, string>)[provider] ?? name;
  const [acknowledged, setAcknowledged] = useState(false);
  const checkboxId = useId();
  const fill = (text: string) => text.replaceAll('{provider}', name).replaceAll('{company}', company);

  // A fresh dialog never starts ticked.
  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={fill(tc.title)}
      confirmLabel={tc.confirm}
      cancelLabel={tc.cancel}
      confirmDisabled={!acknowledged}
      onConfirm={onConfirm}
      description={
        <span className="block space-y-3 text-left">
          <span className="block">{fill(tc.description)}</span>
          <span className="block space-y-1.5">
            <span className="flex gap-2">
              <span aria-hidden>•</span>
              <span>{fill(tc.leaves)}</span>
            </span>
            <span className="flex gap-2">
              <span aria-hidden>•</span>
              <span>{fill(tc.who)}</span>
            </span>
            <span className="flex gap-2">
              <span aria-hidden>•</span>
              <span>{fill(tc.fallback)}</span>
            </span>
            <span className="flex gap-2">
              <span aria-hidden>•</span>
              <span>{fill(tc.owners)}</span>
            </span>
          </span>
          <span className="flex items-start gap-2 text-foreground">
            <Checkbox
              id={checkboxId}
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              className="mt-0.5"
            />
            <label htmlFor={checkboxId} className="text-sm">
              {fill(tc.acknowledge)}
            </label>
          </span>
        </span>
      }
    />
  );
}
