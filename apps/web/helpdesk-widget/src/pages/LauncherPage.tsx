import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isWidgetDisabledError, widgetApi } from '@/lib/api/client';
import { Launcher } from '@/components/widget/chat/launcher';

export function LauncherPage() {
  const [searchParams] = useSearchParams();

  const parentOrigin = searchParams.get('parentOrigin') || undefined;
  const launcherColor = searchParams.get('launcherColor') || undefined;
  const widgetId = searchParams.get('widgetId') || searchParams.get('id') || import.meta.env.VITE_DEFAULT_WIDGET_ID || '';

  // `null` until we know. A disabled widget keeps this frame (the SDK waits for its
  // ready message) but draws nothing; an unreachable API still shows the launcher.
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!widgetId) {
      setEnabled(true);
      return;
    }
    let cancelled = false;
    widgetApi
      .getConfig(widgetId)
      .then((config) => !cancelled && setEnabled(config.enabled !== false))
      .catch((err: unknown) => !cancelled && setEnabled(!isWidgetDisabledError(err)));
    return () => {
      cancelled = true;
    };
  }, [widgetId]);

  return (
    <Launcher
      parentOrigin={parentOrigin}
      launcherColor={launcherColor}
      hidden={enabled !== true}
    />
  );
}
