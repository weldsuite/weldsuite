import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { toast } from 'sonner';
import { useSearchParams, useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useChannelIntegrationStatus,
  useConnectChannelOAuth,
  useSlackSettings,
  useSlackChannels,
  useDisconnectChannel,
} from '@/hooks/queries/use-helpdesk-integration-queries';
import { SlackSettingsClient } from './slack-settings-client';

/**
 * WeldDesk's Slack channel on Settings → Integrations → Slack: support
 * conversations from Slack channels become tickets. desk-api's OAuth sends the
 * browser back to `/settings/integrations/slack?connected=true` (or `?error=`).
 */
export function HelpdeskSlackSection() {
  const { t } = useI18n();
  const st = useTranslations();
  const copy = t.settings.integrations.slackPage;
  const router = useRouter();
  const searchParams = useSearchParams();
  const connected = searchParams.get('connected');
  const oauthError = searchParams.get('error');
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const connectOAuthMutation = useConnectChannelOAuth();
  const disconnectMutation = useDisconnectChannel();

  useEffect(() => {
    if (connected === 'true') {
      toast.success(t.helpdesk.integrationSettings.slackConnected);
      router.replace('/settings/integrations/slack');
    } else if (oauthError) {
      toast.error(st('sweep.welddesk.slackIntegration.connectionFailed', { error: oauthError }));
      router.replace('/settings/integrations/slack');
    }
    // `router`, `t`, and `st` are recreated every render (unmemoized context
    // values): including them would re-fire this OAuth-callback handler
    // (toast + redirect) on every unrelated re-render instead of only when
    // the query params change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, oauthError]);

  const { data: integration, isLoading: integrationLoading } = useChannelIntegrationStatus('slack');
  const isConnected = integration?.status === 'connected';
  const { data: settings, isLoading: settingsLoading } = useSlackSettings(isConnected);
  const { data: channelInfo, isLoading: channelsLoading } = useSlackChannels(isConnected);
  const isLoading = integrationLoading || settingsLoading || channelsLoading;
  const working = isConnecting || disconnectMutation.isPending;

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const { authUrl } = await connectOAuthMutation.mutateAsync('slack');
      if (authUrl) {
        window.location.href = authUrl;
        return;
      }
      toast.error(t.helpdesk.integrationSettings.noAuthUrl);
    } catch (err) {
      toast.error(st('sweep.welddesk.slackIntegration.oauthStartFailed', { error: (err as Error).message }));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      // Prefer the integration id; the provider name is accepted as a fallback.
      await disconnectMutation.mutateAsync(integration?.id ?? 'slack');
      toast.success(t.helpdesk.integrationSettings.slackDisconnected);
      setDisconnectOpen(false);
    } catch {
      toast.error(t.helpdesk.integrationSettings.failedToDisconnectSlack);
    }
  };

  let sectionAction = (
    <Button type="button" disabled={working} onClick={handleConnect}>
      {working ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
      {st('sweep.welddesk.slackIntegration.connectLabel')}
    </Button>
  );
  if (isLoading) {
    sectionAction = <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />;
  } else if (isConnected) {
    sectionAction = (
      <Button
        type="button"
        variant="outline"
        className="hover:text-destructive"
        disabled={working}
        onClick={() => setDisconnectOpen(true)}
      >
        {st('sweep.settings.integrationConnectionCard.disconnect')}
      </Button>
    );
  }

  return (
    <section aria-labelledby="helpdesk-slack" className="mt-10 space-y-4 border-t pt-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="helpdesk-slack" className="text-xl font-semibold text-foreground">
            {copy.helpdeskTitle}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{st('sweep.welddesk.slackIntegration.overview')}</p>
        </div>
        {sectionAction}
      </div>

      {isConnected && integration ? (
        <SlackSettingsClient integration={integration} initialSettings={settings} channelInfo={channelInfo} />
      ) : null}

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={st('sweep.welddesk.slackIntegration.disconnectTitle')}
        description={st('sweep.welddesk.slackIntegration.disconnectDescription')}
        confirmLabel={st('sweep.welddesk.slackIntegration.disconnectConfirmLabel')}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={handleDisconnect}
      />
    </section>
  );
}
