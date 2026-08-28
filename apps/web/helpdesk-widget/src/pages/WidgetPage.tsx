import { useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { HelpdeskWidget } from '@/components/widget/helpdesk-widget';
import { widgetApi } from '@/lib/api/client';
import type { WidgetConfigResponse } from '@/lib/api/types';

export function WidgetPage() {
  const [searchParams] = useSearchParams();
  const widgetId = searchParams.get('widgetId') || searchParams.get('id') || '';
  const parentOrigin = searchParams.get('parentOrigin') || undefined;
  const defaultOpen = searchParams.get('open') === 'true';
  const customerEmail = searchParams.get('email') || undefined;
  const customerName = searchParams.get('name') || undefined;
  const realtimeUrl = searchParams.get('realtimeUrl') || undefined;

  const [config, setConfig] = useState<WidgetConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!widgetId) {
      setError('Missing widgetId');
      return;
    }
    widgetApi
      .getConfig(widgetId)
      .then(setConfig)
      .catch((err: Error) => setError(err.message));
  }, [widgetId]);

  if (error) {
    return <div className="p-4 text-sm text-red-600">{error}</div>;
  }
  if (!config) {
    return <div className="p-4 text-sm text-gray-500">Loading…</div>;
  }

  return (
    <HelpdeskWidget
      widgetId={config.widgetId}
      greeting={config.greeting}
      primaryColor={config.branding.primaryColor}
      backgroundColor={config.branding.backgroundColor}
      position={config.branding.position}
      showBranding={config.showBranding}
      parentOrigin={parentOrigin}
      realtimeUrl={realtimeUrl}
      defaultOpen={defaultOpen}
      customerEmail={customerEmail}
      customerName={customerName}
    />
  );
}
