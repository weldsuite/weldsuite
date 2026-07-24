import { useEffect, useRef, useState } from 'react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Loader2, Hash, Settings, MessageSquare, RefreshCw, Info, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useUpdateSlackSettings, useSlackChannels } from '@/hooks/queries/use-helpdesk-integration-queries';

/**
 * Older/alternate response shape seen from this endpoint, where the channel
 * list is nested under `data` instead of top-level. Narrowed via `unknown`
 * rather than trusted, since the real runtime shape can drift from the
 * declared `SlackWorkspaceInfo` type.
 */
function extractSlackChannels(
  channelInfo: Helpdesk.Api.SlackWorkspaceInfo | undefined,
): Helpdesk.Api.SlackChannelInfo[] | undefined {
  if (!channelInfo) return undefined;
  if (channelInfo.channels) return channelInfo.channels;
  const nested = channelInfo as unknown as { data?: { channels?: Helpdesk.Api.SlackChannelInfo[] } };
  return nested.data?.channels;
}

interface SlackSettingsClientProps {
  integration: Helpdesk.Api.ChannelIntegration;
  initialSettings?: Helpdesk.Api.SlackIntegrationSettings;
  channelInfo?: Helpdesk.Api.SlackWorkspaceInfo;
}

export function SlackSettingsClient({
  integration,
  initialSettings,
  channelInfo,
}: SlackSettingsClientProps) {
  const { t } = useI18n();
  const updateSettingsMutation = useUpdateSlackSettings();
  const slackChannelsQuery = useSlackChannels(false);

  const [supportChannels, setSupportChannels] = useState<Helpdesk.Api.SlackChannelInfo[]>(
    initialSettings?.supportChannels || [],
  );
  const [ignoreBots, setIgnoreBots] = useState(initialSettings?.ignoreBots ?? true);
  const [availableChannels, setAvailableChannels] = useState<Helpdesk.Api.SlackChannelInfo[]>(
    extractSlackChannels(channelInfo) || [],
  );
  const [hasChanges, setHasChanges] = useState(false);

  // Channel search (in Channels tab)
  const [channelSearchOpen, setChannelSearchOpen] = useState(false);
  const [channelSearchQuery, setChannelSearchQuery] = useState('');
  const channelSearchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (channelSearchOpen) channelSearchInputRef.current?.focus();
  }, [channelSearchOpen]);
  const filteredAvailableChannels = (() => {
    const q = channelSearchQuery.trim().toLowerCase();
    if (!q) return availableChannels;
    return availableChannels.filter((ch) =>
      (ch.channelName || ch.channelId || '').toLowerCase().includes(q)
    );
  })();

  const di = t.helpdesk.integrationSettings;
  const tabs: PageTab[] = [
    { id: 'overview', label: di.discordTabOverview, icon: Settings },
    { id: 'channels', label: di.discordTabChannels, icon: Hash },
    { id: 'messages', label: di.discordTabMessages, icon: MessageSquare },
  ];
  const [activeTab, setActiveTab] = useState<string>('overview');

  // Sync available channels when data loads — handle multiple response shapes
  useEffect(() => {
    const channels = extractSlackChannels(channelInfo);
    if (channels?.length) {
      setAvailableChannels(channels);
    }
  }, [channelInfo]);

  useEffect(() => {
    const channelsChanged = JSON.stringify(supportChannels) !== JSON.stringify(initialSettings?.supportChannels || []);
    const botsChanged = ignoreBots !== (initialSettings?.ignoreBots ?? true);
    setHasChanges(channelsChanged || botsChanged);
  }, [supportChannels, ignoreBots, initialSettings]);

  const handleChannelToggle = (channelId: string, channelName: string, enabled: boolean) => {
    setSupportChannels(prev => {
      if (enabled) {
        const existing = prev.find(c => c.channelId === channelId);
        if (existing) return prev.map(c => c.channelId === channelId ? { ...c, enabled: true } : c);
        return [...prev, { channelId, channelName, enabled: true }];
      }
      return prev.filter(c => c.channelId !== channelId);
    });
  };

  const isChannelEnabled = (channelId: string) => {
    return supportChannels.some(c => c.channelId === channelId && c.enabled);
  };

  const handleRefreshChannels = async () => {
    try {
      const result = await slackChannelsQuery.refetch();
      if (result.data?.channels) {
        setAvailableChannels(result.data.channels);
        toast.success(t.helpdesk.integrationSettings.channelsRefreshed);
      }
    } catch {
      toast.error(t.helpdesk.integrationSettings.failedToRefreshChannels);
    }
  };

  const handleSave = async () => {
    try {
      await updateSettingsMutation.mutateAsync({ supportChannels, ignoreBots });
      toast.success(t.helpdesk.integrationSettings.slackSettingsSaved);
      setHasChanges(false);
    } catch {
      toast.error(t.helpdesk.integrationSettings.failedToSaveSettings);
    }
  };

  const handleCancel = () => {
    setSupportChannels(initialSettings?.supportChannels || []);
    setIgnoreBots(initialSettings?.ignoreBots ?? true);
    setHasChanges(false);
  };

  const isRefreshing = slackChannelsQuery.isFetching;

  return (
    <div className="space-y-6">
      <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

      {/* Workspace Info */}
      {activeTab === 'overview' && (
        <Card className="border-0 shadow-none bg-transparent">
          <CardContent className="px-0 pt-0">
            <div>
              <Label className="text-muted-foreground text-sm">{di.slackWorkspaceName}</Label>
              <p className="font-medium">{integration.name || di.slackWorkspaceDefault}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Support Channels */}
      {activeTab === 'channels' && (
        <Card className="border-0 shadow-none bg-transparent">
          <CardContent className="px-0 pt-0">
            <div className="flex justify-end items-center gap-2 mb-3">
              <div className="relative flex items-center">
                <div
                  className={cn(
                    'flex items-center transition-all duration-200 ease-out',
                    channelSearchOpen ? 'w-48' : 'w-8',
                  )}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200',
                      channelSearchOpen && 'opacity-0 pointer-events-none absolute',
                    )}
                    onClick={() => setChannelSearchOpen(true)}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                  <div
                    className={cn(
                      'relative transition-all duration-200 ease-out',
                      channelSearchOpen ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
                    )}
                  >
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <input
                      ref={channelSearchInputRef}
                      type="text"
                      placeholder={di.discordSearchChannels}
                      value={channelSearchQuery}
                      onChange={(e) => setChannelSearchQuery(e.target.value)}
                      onBlur={() => !channelSearchQuery && setChannelSearchOpen(false)}
                      className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                    />
                  </div>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshChannels}
                disabled={isRefreshing}
              >
                {isRefreshing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                <span className="ml-0.5">{di.discordRefresh}</span>
              </Button>
            </div>
            {supportChannels.length === 0 && availableChannels.length > 0 && (
              <Alert className="mb-4">
                <Info className="h-4 w-4" />
                <AlertDescription>
                  {di.discordNoChannelsSelected}
                </AlertDescription>
              </Alert>
            )}
            {availableChannels.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Hash className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>{di.slackNoChannels}</p>
              </div>
            ) : filteredAvailableChannels.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">{di.discordNoChannelsMatch} &ldquo;{channelSearchQuery}&rdquo;.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {filteredAvailableChannels.map((channel) => (
                  <label
                    key={channel.channelId}
                    className={cn(
                      'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                      isChannelEnabled(channel.channelId)
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted/50',
                    )}
                  >
                    <Checkbox
                      checked={isChannelEnabled(channel.channelId)}
                      onCheckedChange={(checked) =>
                        handleChannelToggle(channel.channelId, channel.channelName || '', !!checked)
                      }
                    />
                    <div className="flex items-center gap-2 min-w-0">
                      <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <span className="truncate">{channel.channelName || channel.channelId}</span>
                    </div>
                  </label>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Message Settings */}
      {activeTab === 'messages' && (
        <Card className="border-0 shadow-none bg-transparent">
          <CardContent className="px-0 pt-0 space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="ignore-bots">{di.slackIgnoreBots}</Label>
                <p className="text-sm text-muted-foreground">
                  {di.slackIgnoreBotsDesc}
                </p>
              </div>
              <Switch
                id="ignore-bots"
                checked={ignoreBots}
                onCheckedChange={setIgnoreBots}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Save bar */}
      <div className="flex justify-end gap-2 sticky bottom-0 bg-background/95 backdrop-blur py-4 border-t">
        <Button
          variant="outline"
          className="shadow-none"
          onClick={handleCancel}
          disabled={!hasChanges || updateSettingsMutation.isPending}
        >
          {di.discordCancel}
        </Button>
        <Button
          className="shadow-none"
          onClick={handleSave}
          disabled={!hasChanges || updateSettingsMutation.isPending}
        >
          {updateSettingsMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {di.discordSaving}
            </>
          ) : (
            di.discordSaveChanges
          )}
        </Button>
      </div>
    </div>
  );
}
