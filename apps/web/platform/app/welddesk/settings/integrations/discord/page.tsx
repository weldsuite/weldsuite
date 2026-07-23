import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from '@/lib/router';
import {
  useChannelIntegrationStatus,
  useConnectChannelOAuth,
  useDiscordSettings,
  useDiscordChannels,
  useDisconnectChannel,
} from '@/hooks/queries/use-helpdesk-integration-queries';
import { DiscordSettingsClient } from './discord-settings-client';
import { Globe, FileText, Loader2 } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IntegrationDetailLayout } from '@/components/settings';
import { toast } from 'sonner';

export default function DiscordSettingsPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNewSetup = searchParams.get('setup') === 'true';
  const connected = searchParams.get('connected');
  const oauthError = searchParams.get('error');
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const connectOAuthMutation = useConnectChannelOAuth();
  const disconnectMutation = useDisconnectChannel();

  // Handle OAuth callback query params
  useEffect(() => {
    if (connected === 'true') {
      toast.success(t.helpdesk.integrationSettings.discordConnected);
      router.replace('/settings/integrations/discord');
    } else if (oauthError) {
      toast.error(st('sweep.welddesk.discordIntegration.connectionFailed', { error: oauthError }));
      router.replace('/settings/integrations/discord');
    }
  }, [connected, oauthError]);

  const { data: integration, isLoading: integrationLoading } = useChannelIntegrationStatus('discord');
  const { data: settings, isLoading: settingsLoading } = useDiscordSettings(!!integration?.status);
  const { data: guildInfo, isLoading: channelsLoading } = useDiscordChannels(!!integration?.status);

  const isLoading = integrationLoading || settingsLoading || channelsLoading;
  const isConnected = integration?.status === 'connected';

  const discordIcon = (
    <img
      src="https://www.svgrepo.com/show/349338/discord.svg"
      alt={st('sweep.welddesk.discordIntegration.discordLogoAlt')}
      className="h-9 w-9"
    />
  );

  const handleConnect = async () => {
    setIsConnecting(true);
    try {
      const { authUrl } = await connectOAuthMutation.mutateAsync('discord');
      if (authUrl) {
        window.location.href = authUrl;
        return;
      }
      toast.error(t.helpdesk.integrationSettings.noAuthUrl);
    } catch (err) {
      toast.error(st('sweep.welddesk.discordIntegration.oauthStartFailed', { error: (err as Error).message }));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      // Prefer the integration id; the provider name is accepted as a fallback.
      await disconnectMutation.mutateAsync(integration?.id ?? 'discord');
      toast.success(t.helpdesk.integrationSettings.discordDisconnected);
      setDisconnectOpen(false);
    } catch {
      toast.error(t.helpdesk.integrationSettings.failedToDisconnectDiscord);
    }
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <>
      <IntegrationDetailLayout
        name="Discord"
        description={st('sweep.welddesk.discordIntegration.description')}
        category={st('sweep.welddesk.discordIntegration.categorySupport')}
        icon={discordIcon}
        connected={isConnected}
        isWorking={isConnecting || disconnectMutation.isPending}
        connectLabel={st('sweep.welddesk.discordIntegration.connectLabel')}
        onConnect={handleConnect}
        onDisconnect={() => setDisconnectOpen(true)}
        provider="Discord"
        resources={[
          { label: st('sweep.welddesk.discordIntegration.websiteLabel'), href: 'https://discord.com', icon: Globe },
          { label: st('sweep.welddesk.discordIntegration.documentationLabel'), href: 'https://discord.com/developers/docs', icon: FileText },
        ]}
        overview={st('sweep.welddesk.discordIntegration.overview')}
      >
        {isConnected && integration && (
          <DiscordSettingsClient
            integration={integration as any}
            initialSettings={settings as any}
            guildInfo={guildInfo as any}
            isNewSetup={isNewSetup}
          />
        )}
      </IntegrationDetailLayout>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={st('sweep.welddesk.discordIntegration.disconnectTitle')}
        description={st('sweep.welddesk.discordIntegration.disconnectDescription')}
        confirmLabel={st('sweep.welddesk.discordIntegration.disconnectConfirmLabel')}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={handleDisconnect}
      />
    </>
  );
}
