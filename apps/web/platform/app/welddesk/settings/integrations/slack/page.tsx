import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from '@/lib/router';
import {
  useChannelIntegrationStatus,
  useConnectChannelOAuth,
  useSlackSettings,
  useSlackChannels,
  useDisconnectChannel,
} from '@/hooks/queries/use-helpdesk-integration-queries';
import { SlackSettingsClient } from './slack-settings-client';
import { Globe, FileText } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IntegrationDetailLayout } from '@/components/settings';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

export default function SlackSettingsPage() {
  const { t } = useI18n();
  const st = useTranslations();
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
  }, [connected, oauthError]);

  const { data: integration, isLoading: integrationLoading } = useChannelIntegrationStatus('slack');
  const isConnected = integration?.status === 'connected';
  const { data: settings, isLoading: settingsLoading } = useSlackSettings(isConnected);
  const { data: channelInfo, isLoading: channelsLoading } = useSlackChannels(isConnected);

  const isLoading = integrationLoading || settingsLoading || channelsLoading;

  const slackIcon = (
    <img
      src="https://upload.wikimedia.org/wikipedia/commons/d/d5/Slack_icon_2019.svg"
      alt={st('sweep.welddesk.slackIntegration.slackLogoAlt')}
      className="h-[26px] w-[26px]"
    />
  );

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

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <>
      <IntegrationDetailLayout
        name="Slack"
        description={st('sweep.welddesk.slackIntegration.description')}
        category={st('sweep.welddesk.slackIntegration.categorySupport')}
        icon={slackIcon}
        connected={isConnected}
        isWorking={isConnecting || disconnectMutation.isPending}
        connectLabel={st('sweep.welddesk.slackIntegration.connectLabel')}
        onConnect={handleConnect}
        onDisconnect={() => setDisconnectOpen(true)}
        provider="Slack"
        resources={[
          { label: st('sweep.welddesk.slackIntegration.websiteLabel'), href: 'https://slack.com', icon: Globe },
          { label: st('sweep.welddesk.slackIntegration.documentationLabel'), href: 'https://api.slack.com', icon: FileText },
        ]}
        overview={st('sweep.welddesk.slackIntegration.overview')}
      >
        {isConnected && integration && (
          <SlackSettingsClient
            integration={integration as any}
            initialSettings={settings}
            channelInfo={channelInfo}
          />
        )}
      </IntegrationDetailLayout>

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
    </>
  );
}
