import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useProviderCallback } from '@/hooks/queries/use-integration-queries';

export default function HubSpotCallbackClient() {
  const t = useTranslations();
  const router = useRouter();
  const callbackMutation = useProviderCallback();
  const processed = React.useRef(false);

  React.useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (!code || !state) {
      toast.error(t('sweep.settings.oauthCallback.invalidCallback'));
      router.push('/settings/integrations');
      return;
    }

    const redirectUri = `${window.location.origin}/settings/integrations/hubspot/callback`;

    (async () => {
      try {
        await callbackMutation.mutateAsync({ provider: 'hubspot', code, state, redirectUri });
        toast.success(t('sweep.settings.oauthCallback.connectedSuccessfully', { provider: 'HubSpot' }));
        router.push('/settings/integrations');
      } catch (err) {
        console.error('[HubSpot callback] Error:', err);
        toast.error(err instanceof Error ? err.message : t('sweep.settings.oauthCallback.connectFailed', { provider: 'HubSpot' }));
        router.push('/settings/integrations');
      }
    })();
  }, [callbackMutation, router, t]);

  return (
    <div className="w-full flex items-center justify-center h-full min-h-[calc(100vh-8rem)] pb-[60px]">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('sweep.settings.oauthCallback.connectingTo', { provider: 'HubSpot' })}</p>
      </div>
    </div>
  );
}
