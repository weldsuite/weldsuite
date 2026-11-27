import { useEffect, useState } from 'react';
import { useDesktopSettings } from '@/hooks/use-desktop-settings';
import { getDesktop, isDesktop } from '@/lib/desktop';
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

type AppInfo = Awaited<ReturnType<NonNullable<ReturnType<typeof getDesktop>>['getAppInfo']>>;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** What the shell says about itself; null outside the shell or until it answers. */
function useDesktopAppInfo(): AppInfo | null {
  const desktop = getDesktop();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    desktop
      .getAppInfo()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  return info;
}

/**
 * The server the shell opens, and "Change server…", which opens the shell's
 * own window for it (shells 0.3.0 and later; older ones show the server only).
 */
export function DesktopServerRow() {
  const { t, format } = useI18n();
  const ts = t.common.desktop.settings.server;
  const desktop = getDesktop();
  const info = useDesktopAppInfo();
  const host = info ? hostOf(info.appUrl) : null;

  if (!desktop || !host) return null;

  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="space-y-1">
        <p className="text-sm leading-none font-medium">{ts.label}</p>
        <p className="text-sm text-muted-foreground">{format(ts.description, { host })}</p>
      </div>
      {typeof desktop.openServerSettings === 'function' && (
        <Button variant="outline" size="sm" onClick={() => void desktop.openServerSettings?.()}>
          {ts.change}
        </Button>
      )}
    </div>
  );
}

/**
 * Drop-in desktop settings card. Renders nothing when not running inside the
 * Electron shell — safe to include unconditionally on any settings page.
 */
export function DesktopSettingsPanel() {
  const { t } = useI18n();
  const ts = t.common.desktop.settings;
  const { settings, loading, update, restartRequired, relaunch } = useDesktopSettings();
  const info = useDesktopAppInfo();
  // A Microsoft Store install can't launch at login: Windows keeps that in
  // the package's manifest, out of the shell's reach.
  const rows = info?.windowsStore ? ROWS.filter((row) => row.key !== 'autoLaunch') : ROWS;

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
            <DesktopServerRow />
            {rows.map((row) => (
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
