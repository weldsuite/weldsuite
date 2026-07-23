import { useDesktopSettings } from '@/hooks/use-desktop-settings';
import { isDesktop } from '@/lib/desktop';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@weldsuite/ui/components/card';
import { AlertTriangle, Monitor } from 'lucide-react';
import type { DesktopSettings } from '@/types/weldsuite-desktop';

interface Row {
  key: keyof DesktopSettings;
  label: string;
  description: string;
  restartRequired?: boolean;
}

const ROWS: Row[] = [
  {
    key: 'autoLaunch',
    label: 'Launch at system startup',
    description: 'Start WeldSuite automatically when you log in.',
  },
  {
    key: 'startMinimized',
    label: 'Start minimized to tray',
    description: 'Open hidden in the system tray instead of showing the window.',
  },
  {
    key: 'closeToTray',
    label: 'Close button minimizes to tray',
    description: 'Clicking × hides the window instead of quitting. Quit from the tray to fully exit.',
  },
  {
    key: 'notificationsEnabled',
    label: 'OS notifications',
    description: 'Show notifications from WeldSuite in your system notification center.',
  },
  {
    key: 'hardwareAcceleration',
    label: 'Hardware acceleration',
    description: 'Use the GPU for rendering. Disable if you see graphical glitches.',
    restartRequired: true,
  },
];

/**
 * Drop-in desktop settings card. Renders nothing when not running inside the
 * Electron shell — safe to include unconditionally on any settings page.
 */
export function DesktopSettingsPanel() {
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
            <CardTitle>Desktop app</CardTitle>
            <CardDescription>Preferences for the WeldSuite desktop application.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {restartRequired.length > 0 && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>A restart is required to apply your changes.</span>
              <Button size="sm" onClick={relaunch}>Restart now</Button>
            </AlertDescription>
          </Alert>
        )}

        {loading && <p className="text-sm text-muted-foreground">Loading settings…</p>}

        {settings && (
          <div className="divide-y">
            {ROWS.map((row) => (
              <div key={row.key} className="flex items-start justify-between gap-6 py-4">
                <div className="space-y-1">
                  <Label htmlFor={`desktop-setting-${row.key}`} className="font-medium">
                    {row.label}
                    {row.restartRequired && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">· restart required</span>
                    )}
                  </Label>
                  <p className="text-sm text-muted-foreground">{row.description}</p>
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
