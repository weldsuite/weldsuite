import { useState, type ComponentType, type ReactNode } from 'react';
import { FlaskConical, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import type { FormIntegration } from '@weldsuite/app-api-client/schemas/weldforms';
import { useI18n } from '@/lib/i18n/provider';

/**
 * The frame of a kind's integration card: title, enable switch, the form
 * (children), the last error, and Save / Test run / Remove. A card with no
 * saved integration shows "Not set up" and saves by creating it.
 */
export function IntegrationCard({
  icon: Icon,
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
  icon: ComponentType<{ className?: string }>;
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

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {title}
              {!integration && <SoftBadge tone="neutral">{ti.notSetUp}</SoftBadge>}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={switchId} className="text-sm">
            {ti.enabled}
          </Label>
          <Switch id={switchId} checked={enabled} onCheckedChange={onEnabledChange} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {integration?.lastError && (
          <InfoBanner variant="danger">
            <p className="font-medium">{ti.lastError}</p>
            <p className="break-words">{integration.lastError}</p>
          </InfoBanner>
        )}
        {children}
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button type="button" disabled={!canSave || saving} onClick={onSave}>
            {saving ? t.weldformsResults.common.saving : integration ? ti.save : ti.setUp}
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
      </CardContent>
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
    </Card>
  );
}
