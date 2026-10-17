import { useDesktopSettings } from '@/hooks/use-desktop-settings';
import { isDesktop } from '@/lib/desktop';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@weldsuite/ui/components/card';
import { AlertTriangle, Monitor } from 'lucide-react';
import type { DesktopSettings } from '@/types/weldsuite-desktop';
import { useI18n } from '@/lib/i18n/provider';

interface Row {
  key: keyof DesktopSettings;
  /** Key of the label/description pair in `common.desktop.settings.rows`. */
  copy: 'autoLaunch' | 'startMinimized' | 'closeToTray' | 'notificationsEnabled' | 'hardwareAcceleration';
  restartRequired?: boolean;
}

const ROWS: Row[] = [
  { key: 'autoLaunch', copy: 'autoLaunch' },
  { key: 'startMinimized', copy: 'startMinimized' },
  { key: 'closeToTray', copy: 'closeToTray' },
  { key: 'notificationsEnabled', copy: 'notificationsEnabled' },
  { key: 'hardwareAcceleration', copy: 'hardwareAcceleration', restartRequired: true },
];

/**
 * Drop-in desktop settings card. Renders nothing when not running inside the
 * Electron shell — safe to include unconditionally on any settings page.
 */
export function DesktopSettingsPanel() {
  const { t } = useI18n();
  const ts = t.common.desktop.settings;
  const { settings, loading, update, restartRequired, relaunch } = useDesktopSettings();

  if (!isDesktop()) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Monitor className="h-5 w-5" />
          </div>
          <div>
            <CardTitle>{ts.title}</CardTitle>
            <CardDescription>{ts.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {restartRequired.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{ts.restartBanner}</span>
              <Button size="sm" onClick={relaunch}>{ts.restartNow}</Button>
            </AlertDescription>
          </Alert>
        )}

        {loading && <p className="text-sm text-muted-foreground">{ts.loading}</p>}

        {settings && (
          <div className="divide-y">
            {ROWS.map((row) => (
              <div key={row.key} className="flex items-start justify-between gap-6 py-4">
                <div className="space-y-1">
                  <Label htmlFor={`desktop-setting-${row.key}`} className="font-medium">
                    {ts.rows[row.copy].label}
                    {row.restartRequired && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">· {ts.restartRequired}</span>
                    )}
                  </Label>
                  <p className="text-sm text-muted-foreground">{ts.rows[row.copy].description}</p>
                </div>
                <Switch
                  id={`desktop-setting-${row.key}`}
                  checked={settings[row.key]}
                  onCheckedChange={(checked) => update({ [row.key]: checked } as Partial<DesktopSettings>)}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
