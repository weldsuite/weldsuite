import { useState, type ReactNode } from 'react';
import { FlaskConical, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import type { FormIntegration } from '@weldsuite/app-api-client/schemas/weldforms';
import { useI18n } from '@/lib/i18n/provider';
import { IntegrationHeader, IntegrationLogo, IntegrationStatus } from './app-tile';

/**
 * A kind's integration, opened from its card: a header with the Back button,
 * the app's logo, name, status and enable switch, then the last error, the
 * form (children) and Save / Test run / Remove. One with no saved integration
 * saves by creating it.
 */
export function IntegrationCard({
  appCode,
  onBack,
  title,
  description,
  removeAction,
  integration,
  enabled,
  onEnabledChange,
  canSave,
  saving,
  onSave,
  testing,
  onTest,
  removing,
  onRemove,
  children,
}: Readonly<{
  /** The app it runs in, for the logo: `weldcrm`, `welddesk`, `weldflow`. */
  appCode: string;
  /** Back to the cards. */
  onBack: () => void;
  title: string;
  description: string;
  /** Completes "New responses no longer …": "create people". */
  removeAction: string;
  integration: FormIntegration | null;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  testing: boolean;
  onTest: () => void;
  removing: boolean;
  onRemove: () => void;
  children: ReactNode;
}>) {
  const { t, format } = useI18n();
  const ti = t.weldformsResults.integrations;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const switchId = `integration-${title}-enabled`;
  let saveLabel = integration ? ti.save : ti.setUp;
  if (saving) saveLabel = t.weldformsResults.common.saving;

  return (
    <div className="space-y-6">
      <IntegrationHeader
        className="border-b pb-6"
        logo={<IntegrationLogo code={appCode} />}
        title={title}
        badge={<IntegrationStatus integration={integration} />}
        description={description}
        onBack={onBack}
        aside={
          <>
            <Label htmlFor={switchId} className="text-sm">
              {ti.enabled}
            </Label>
            <Switch id={switchId} checked={enabled} onCheckedChange={onEnabledChange} />
          </>
        }
      />
      {integration?.lastError && (
        <InfoBanner variant="danger">
          <p className="font-medium">{ti.lastError}</p>
          <p className="break-words">{integration.lastError}</p>
        </InfoBanner>
      )}
      <div className="space-y-5">
        {children}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button type="button" disabled={!canSave || saving} onClick={onSave}>
            {saveLabel}
          </Button>
          {integration && (
            <>
              <Button type="button" variant="outline" disabled={testing} onClick={onTest} title={ti.testHint}>
                <FlaskConical className="mr-1.5 h-4 w-4" />
                {testing ? ti.testing : ti.test}
              </Button>
              <Button type="button" variant="ghost" className="ml-auto text-destructive" onClick={() => setConfirmRemove(true)}>
                <Trash2 className="mr-1.5 h-4 w-4" />
                {ti.remove}
              </Button>
            </>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={ti.removeTitle}
        description={format(ti.removeDescription, { action: removeAction })}
        variant="destructive"
        confirmLabel={ti.remove}
        cancelLabel={t.weldformsResults.common.cancel}
        loading={removing}
        onConfirm={() => {
          onRemove();
          setConfirmRemove(false);
        }}
      />
    </div>
  );
}
