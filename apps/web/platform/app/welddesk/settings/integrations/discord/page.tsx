import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useRouter } from '@/lib/router';
import {
  useConnectChannelOAuth,
  useDiscordServers,
  useDiscordSettings,
  useDiscordChannels,
  useDisconnectChannel,
} from '@/hooks/queries/use-helpdesk-integration-queries';
import { DiscordSettingsClient } from './discord-settings-client';
import { Globe, FileText, Plus } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IntegrationDetailLayout } from '@/components/settings';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { toast } from 'sonner';

export default function DiscordSettingsPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNewSetup = searchParams.get('setup') === 'true';
  const connected = searchParams.get('connected');
  const oauthError = searchParams.get('error');
  const queryIntegrationId = searchParams.get('integrationId');
  const [isConnecting, setIsConnecting] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(
    queryIntegrationId,
  );
  const connectOAuthMutation = useConnectChannelOAuth();
  const disconnectMutation = useDisconnectChannel();

  const { data: servers = [], isLoading: serversLoading, refetch: refetchServers } =
    useDiscordServers();

  // Handle OAuth callback query params
  useEffect(() => {
    if (connected === 'true') {
      toast.success(t.helpdesk.integrationSettings.discordConnected);
      void refetchServers();
      if (queryIntegrationId) setSelectedIntegrationId(queryIntegrationId);
      router.replace('/settings/integrations/discord');
    } else if (oauthError) {
      toast.error(
        st('sweep.welddesk.discordIntegration.connectionFailed', { error: oauthError }),
      );
      router.replace('/settings/integrations/discord');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, oauthError, queryIntegrationId]);

  // Keep selection valid when the server list loads/changes
  useEffect(() => {
    if (servers.length === 0) {
      setSelectedIntegrationId(null);
      return;
    }
    if (
      !selectedIntegrationId ||
      !servers.some((server) => server.id === selectedIntegrationId)
    ) {
      setSelectedIntegrationId(servers[0].id);
    }
  }, [servers, selectedIntegrationId]);

  const selectedServer = useMemo(
    () => servers.find((server) => server.id === selectedIntegrationId) ?? null,
    [servers, selectedIntegrationId],
  );

  const { data: settings, isLoading: settingsLoading } = useDiscordSettings(
    selectedIntegrationId,
    !!selectedServer,
  );
  const { data: guildInfo, isLoading: channelsLoading } = useDiscordChannels(
    selectedIntegrationId,
    !!selectedServer,
  );

  const isLoading =
    serversLoading || (!!selectedServer && (settingsLoading || channelsLoading));
  const isConnected = servers.some((server) => server.status === 'connected');

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
      toast.error(
        st('sweep.welddesk.discordIntegration.oauthStartFailed', {
          error: (err as Error).message,
        }),
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!selectedServer?.id) return;
    try {
      await disconnectMutation.mutateAsync(selectedServer.id);
      toast.success(t.helpdesk.integrationSettings.discordDisconnected);
      setDisconnectOpen(false);
      const remaining = servers.filter((server) => server.id !== selectedServer.id);
      setSelectedIntegrationId(remaining[0]?.id ?? null);
      void refetchServers();
    } catch {
      toast.error(t.helpdesk.integrationSettings.failedToDisconnectDiscord);
    }
  };

  if (isLoading && servers.length === 0) {
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
        connectLabel={
          isConnected
            ? 'Add Discord server'
            : st('sweep.welddesk.discordIntegration.connectLabel')
        }
        onConnect={handleConnect}
        onDisconnect={isConnected ? () => setDisconnectOpen(true) : undefined}
        provider="Discord"
        resources={[
          {
            label: st('sweep.welddesk.discordIntegration.websiteLabel'),
            href: 'https://discord.com',
            icon: Globe,
          },
          {
            label: st('sweep.welddesk.discordIntegration.documentationLabel'),
            href: 'https://discord.com/developers/docs',
            icon: FileText,
          },
        ]}
        overview={st('sweep.welddesk.discordIntegration.overview')}
      >
        {isConnected && (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1.5 min-w-0 flex-1">
                <p className="text-sm font-medium">Connected servers</p>
                <Select
                  value={selectedIntegrationId ?? undefined}
                  onValueChange={setSelectedIntegrationId}
                >
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue placeholder="Select a Discord server" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((server) => (
                      <SelectItem key={server.id} value={server.id}>
                        {server.guildName || server.name || server.guildId || server.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleConnect}
                disabled={isConnecting}
                className="shrink-0"
              >
                <Plus className="h-4 w-4 mr-1.5" />
                Add server
              </Button>
            </div>

            {selectedServer && settings && !settingsLoading && !channelsLoading ? (
              <DiscordSettingsClient
                key={selectedServer.id}
                integration={selectedServer}
                initialSettings={settings}
                guildInfo={guildInfo}
                isNewSetup={isNewSetup}
              />
            ) : selectedServer ? (
              <PageLoader fullScreen={false} />
            ) : null}
          </div>
        )}
      </IntegrationDetailLayout>

      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={st('sweep.welddesk.discordIntegration.disconnectTitle')}
        description={
          selectedServer
            ? `Disconnect ${selectedServer.guildName || selectedServer.name || 'this Discord server'} from WeldDesk? Other connected servers stay linked.`
            : st('sweep.welddesk.discordIntegration.disconnectDescription')
        }
        confirmLabel={st('sweep.welddesk.discordIntegration.disconnectConfirmLabel')}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={handleDisconnect}
      />
    </>
  );
}
