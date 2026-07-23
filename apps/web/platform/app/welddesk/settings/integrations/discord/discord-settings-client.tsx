
import { useState, useTransition, useEffect, useRef } from 'react';
import { useRouter } from '@/lib/router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Badge } from '@weldsuite/ui/components/badge';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@weldsuite/ui/components/alert-dialog';
import {
  Loader2,
  MessageCircle,
  Hash,
  CheckCircle,
  CircleCheck,
  Search,
  Info,
  Settings,
  MessageSquare,
  Bot,
  RefreshCw,
  Paintbrush,
  Camera,
  X,
  Ticket,
  Send,
  Unplug,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import type { Helpdesk } from '@/lib/api/types/apps/helpdesk.types';
import { useUpdateDiscordSettings, useDiscordChannels, usePostTicketPanel, useDisconnectChannel } from '@/hooks/queries/use-helpdesk-integration-queries';
import { useFileUpload } from '@/hooks/use-file-upload';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Upload } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  ColorPicker,
  ColorPickerSelection,
  ColorPickerHue,
  ColorPickerAlpha,
  ColorPickerFormat,
} from '@weldsuite/ui/components/color-picker';

// Local-state picker: keeps high-frequency hue/saturation updates contained
// inside the popover so the parent form (and all five tabs) doesn't re-render
// on every pixel of mouse movement. Commits the chosen colour back to the
// parent only when the popover closes.
function EmbedColorPicker({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const st = useTranslations();
  const [open, setOpen] = useState(false);
  const [localValue, setLocalValue] = useState(value);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && localValue !== value) {
      onChange(localValue);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          id="panel-embed-color"
          aria-label={st('sweep.welddesk.discordSettings.pickEmbedColorAriaLabel')}
          className="h-9 w-9 rounded-md border border-input shrink-0 cursor-pointer p-0"
          style={{ backgroundColor: open ? localValue : value }}
        />
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3" align="start">
        <ColorPicker
          defaultValue={localValue}
          onChange={(next) => {
            if (!Array.isArray(next)) return;
            const [r, g, b] = next as [number, number, number, number];
            const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
            setLocalValue(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
          }}
          className="h-auto w-full"
        >
          <ColorPickerSelection className="h-32 rounded-md" />
          <ColorPickerHue className="mt-2" />
          <ColorPickerAlpha className="-mt-2" />
          <ColorPickerFormat className="shadow-none mt-2" />
        </ColorPicker>
      </PopoverContent>
    </Popover>
  );
}

interface DiscordSettingsClientProps {
  integration: Helpdesk.Api.ChannelIntegration;
  initialSettings?: Helpdesk.Api.DiscordIntegrationSettings;
  guildInfo?: Helpdesk.Api.DiscordGuildInfo;
  isNewSetup?: boolean;
}

export function DiscordSettingsClient({
  integration,
  initialSettings,
  guildInfo,
  isNewSetup,
}: DiscordSettingsClientProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const updateDiscordSettingsMutation = useUpdateDiscordSettings();
  const discordChannelsQuery = useDiscordChannels(false);
  const postTicketPanelMutation = usePostTicketPanel();
  const disconnectMutation = useDisconnectChannel();
  const [isPending, startTransition] = useTransition();

  // Settings state
  const [supportChannels, setSupportChannels] = useState<Helpdesk.Api.DiscordChannelInfo[]>(
    initialSettings?.supportChannels || []
  );
  const [processDirectMessages, setProcessDirectMessages] = useState(
    initialSettings?.processDirectMessages ?? true
  );
  const [ignoreBots, setIgnoreBots] = useState(
    initialSettings?.ignoreBots ?? true
  );
  const [supportPrefix, setSupportPrefix] = useState(
    initialSettings?.supportPrefix || ''
  );
  const [autoReplyMessage, setAutoReplyMessage] = useState(
    initialSettings?.autoReplyMessage || ''
  );
  const [botDisplayName, setBotDisplayName] = useState(
    initialSettings?.botDisplayName || ''
  );
  const [botAvatarUrl, setBotAvatarUrl] = useState(
    initialSettings?.botAvatarUrl || ''
  );

  // Ticket panel state
  const [panelChannelId, setPanelChannelId] = useState(
    initialSettings?.ticketPanel?.channelId || ''
  );
  const [panelEmbedTitle, setPanelEmbedTitle] = useState(
    initialSettings?.ticketPanel?.embedTitle || 'Support Tickets'
  );
  const [panelEmbedDescription, setPanelEmbedDescription] = useState(
    initialSettings?.ticketPanel?.embedDescription || 'Click the button below to open a support ticket.'
  );
  const [panelEmbedColor, setPanelEmbedColor] = useState(
    initialSettings?.ticketPanel?.embedColor || '#5865F2'
  );
  const [panelButtonText, setPanelButtonText] = useState(
    initialSettings?.ticketPanel?.buttonText || 'Open a Ticket'
  );
  const [panelButtonStyle, setPanelButtonStyle] = useState(
    initialSettings?.ticketPanel?.buttonStyle || 1
  );
  const [panelMessageId, setPanelMessageId] = useState(
    initialSettings?.ticketPanel?.messageId || ''
  );

  // Avatar file upload
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const { uploadFile: uploadAvatar, isUploading: isAvatarUploading } = useFileUpload({
    folder: 'discord-bots',
    entityType: 'discord-bot-avatar',
    isPublic: true,
    allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    maxFileSize: 8 * 1024 * 1024,
    onSuccess: (file) => {
      setBotAvatarUrl(file.url);
      toast.success(t.helpdesk.integrationSettings.avatarUploaded);
    },
    onError: (error) => {
      toast.error(error);
    },
  });

  const handleAvatarFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      await uploadAvatar(file);
    }
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  };

  // Available channels from Discord
  const [availableChannels, setAvailableChannels] = useState<Helpdesk.Api.DiscordChannelInfo[]>(
    guildInfo?.channels || []
  );

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

  // Track changes
  const [hasChanges, setHasChanges] = useState(false);

  // Show welcome message for new setups
  const [showWelcome, setShowWelcome] = useState(isNewSetup);

  useEffect(() => {
    // Mark as changed when any setting changes from initial
    const channelsChanged = JSON.stringify(supportChannels) !== JSON.stringify(initialSettings?.supportChannels || []);
    const dmChanged = processDirectMessages !== (initialSettings?.processDirectMessages ?? true);
    const botsChanged = ignoreBots !== (initialSettings?.ignoreBots ?? true);
    const prefixChanged = supportPrefix !== (initialSettings?.supportPrefix || '');
    const autoReplyChanged = autoReplyMessage !== (initialSettings?.autoReplyMessage || '');
    const displayNameChanged = botDisplayName !== (initialSettings?.botDisplayName || '');
    const avatarUrlChanged = botAvatarUrl !== (initialSettings?.botAvatarUrl || '');

    setHasChanges(channelsChanged || dmChanged || botsChanged || prefixChanged || autoReplyChanged || displayNameChanged || avatarUrlChanged);
  }, [supportChannels, processDirectMessages, ignoreBots, supportPrefix, autoReplyMessage, botDisplayName, botAvatarUrl, initialSettings]);

  const handleChannelToggle = (channelId: string, channelName: string, enabled: boolean) => {
    setSupportChannels(prev => {
      const existing = prev.find(c => c.channelId === channelId);
      if (enabled) {
        if (existing) {
          return prev.map(c => c.channelId === channelId ? { ...c, enabled: true } : c);
        }
        return [...prev, { channelId, channelName, enabled: true }];
      } else {
        return prev.filter(c => c.channelId !== channelId);
      }
    });
  };

  const isChannelEnabled = (channelId: string) => {
    return supportChannels.some(c => c.channelId === channelId && c.enabled);
  };

  const handleRefreshChannels = async () => {
    try {
      const result = await discordChannelsQuery.refetch();
      if (result.data?.channels) {
        setAvailableChannels(result.data.channels);
        toast.success(t.helpdesk.integrationSettings.channelsRefreshed);
      } else {
        toast.error(t.helpdesk.integrationSettings.failedToRefreshChannels);
      }
    } catch {
      toast.error(t.helpdesk.integrationSettings.failedToRefreshChannels);
    }
  };

  const isRefreshing = discordChannelsQuery.isFetching;

  const handleSave = async () => {
    try {
      await updateDiscordSettingsMutation.mutateAsync({
        supportChannels,
        processDirectMessages,
        ignoreBots,
        supportPrefix: supportPrefix || undefined,
        autoReplyMessage: autoReplyMessage || undefined,
        botDisplayName: botDisplayName || undefined,
        botAvatarUrl: botAvatarUrl || undefined,
      });

      toast.success(t.helpdesk.integrationSettings.discordSettingsSaved);
      setHasChanges(false);
    } catch (error) {
      toast.error(t.helpdesk.integrationSettings.failedToSaveSettings);
    }
  };

  const handleCancel = () => {
    setSupportChannels(initialSettings?.supportChannels || []);
    setProcessDirectMessages(initialSettings?.processDirectMessages ?? true);
    setIgnoreBots(initialSettings?.ignoreBots ?? true);
    setSupportPrefix(initialSettings?.supportPrefix || '');
    setAutoReplyMessage(initialSettings?.autoReplyMessage || '');
    setBotDisplayName(initialSettings?.botDisplayName || '');
    setBotAvatarUrl(initialSettings?.botAvatarUrl || '');
    setHasChanges(false);
  };

  const handleSendPanel = async () => {
    if (!panelChannelId) {
      toast.error(t.helpdesk.integrationSettings.pleaseSelectChannel);
      return;
    }

    try {
      const channelName = availableChannels.find(ch => ch.channelId === panelChannelId)?.channelName;
      const result = await postTicketPanelMutation.mutateAsync({
        channelId: panelChannelId,
        channelName,
        embedTitle: panelEmbedTitle,
        embedDescription: panelEmbedDescription,
        embedColor: panelEmbedColor,
        buttonText: panelButtonText,
        buttonStyle: panelButtonStyle,
      });
      setPanelMessageId(result.messageId);
      toast.success(t.helpdesk.integrationSettings.ticketPanelPosted);
    } catch {
      toast.error(t.helpdesk.integrationSettings.failedToPostTicketPanel);
    }
  };

  const di = t.helpdesk.integrationSettings;
  const tabs: PageTab[] = [
    { id: 'overview', label: di.discordTabOverview, icon: Settings },
    { id: 'bot', label: di.discordTabBot, icon: Bot },
    { id: 'panel', label: di.discordTabPanel, icon: Ticket },
    { id: 'channels', label: di.discordTabChannels, icon: Hash },
    { id: 'messages', label: di.discordTabMessages, icon: MessageSquare },
  ];
  const [activeTab, setActiveTab] = useState<string>('overview');

  return (
    <div className="space-y-6">
        {/* Welcome Alert for New Setup */}
        {showWelcome && (
          <Alert className="border-[#5865F2]/50 bg-[#5865F2]/10">
            <CheckCircle className="h-4 w-4" style={{ color: '#5865F2' }} />
            <AlertTitle>{di.discordConnectedSuccessfully}</AlertTitle>
            <AlertDescription>
              {di.discordConnectedDesc}
            </AlertDescription>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() => setShowWelcome(false)}
            >
              {di.discordDismiss}
            </Button>
          </Alert>
        )}

        {/* Tabs */}
        <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Server Info */}
        {activeTab === 'overview' && (
        <Card className="border-0 shadow-none bg-transparent">
          <CardContent className="px-0 pt-0">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground text-sm">{di.discordServerName}</Label>
                <p className="font-medium">{guildInfo?.guildName || integration.name}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-sm">{di.discordServerId}</Label>
                <p className="font-mono text-sm">{guildInfo?.guildId || integration.accountInfo?.id}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        )}

        {/* Bot Appearance */}
        {activeTab === 'bot' && (
        <Card className="border-0 shadow-none bg-transparent">
          <CardContent className="px-0 pt-0 space-y-4">
            <div>
              <Label htmlFor="bot-display-name">{di.discordBotDisplayName}</Label>
              <Input
                id="bot-display-name"
                value={botDisplayName}
                onChange={(e) => setBotDisplayName(e.target.value)}
                placeholder={integration.name || 'Bot name'}
                maxLength={80}
                className="mt-1.5 shadow-none"
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                {di.discordBotDisplayNameDesc}
              </p>
            </div>

            <div className="flex items-center gap-4 pt-4">
              <div className="relative">
                <Avatar className="h-20 w-20 rounded-[1.25rem]">
                  {botAvatarUrl ? (
                    <img src={botAvatarUrl} alt={st('sweep.welddesk.discordSettings.botAvatarAlt')} className="object-cover w-full h-full" />
                  ) : (
                    <AvatarFallback className="rounded-[1.25rem] bg-muted">
                      <img
                        src="/assets/images/weldagent/logo-light.png"
                        alt="WeldAgent"
                        className="h-10 w-10 object-contain"
                      />
                    </AvatarFallback>
                  )}
                </Avatar>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">{di.discordBotAvatar}</p>
                <p className="text-xs text-muted-foreground mb-2">{di.discordBotAvatarDesc}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shadow-none"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={isAvatarUploading}
                >
                  {isAvatarUploading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-0.5" />
                      {di.discordUploading}
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-0.5" />
                      {di.discordChooseFile}
                    </>
                  )}
                </Button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  className="hidden"
                  onChange={handleAvatarFileChange}
                  disabled={isAvatarUploading}
                />
              </div>
            </div>
          </CardContent>
        </Card>
        )}

        {/* Ticket Panel */}
        {activeTab === 'panel' && (
        <Card className="border-0 shadow-none bg-transparent">
          <CardContent className="px-0 pt-0 space-y-4">
            {panelMessageId && (
              <Alert className="border-green-500/50 bg-green-500/10">
                <CircleCheck className="h-4 w-4 text-green-600" />
                <AlertDescription>
                  {di.discordPanelPosted}
                </AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label>{di.discordChannelLabel}</Label>
              <Select value={panelChannelId} onValueChange={setPanelChannelId}>
                <SelectTrigger className="shadow-none">
                  <SelectValue placeholder={di.discordChannelPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {availableChannels.map((ch) => (
                    <SelectItem key={ch.channelId} value={ch.channelId}>
                      <span className="flex items-center gap-2">
                        <Hash className="h-3.5 w-3.5 text-muted-foreground" />
                        {ch.channelName || ch.channelId}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {di.discordChannelDesc}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="panel-embed-title">{di.discordEmbedTitle}</Label>
              <Input
                id="panel-embed-title"
                value={panelEmbedTitle}
                onChange={(e) => setPanelEmbedTitle(e.target.value)}
                placeholder={st('sweep.welddesk.discordSettings.supportTicketsPlaceholder')}
                maxLength={256}
                className="shadow-none"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="panel-embed-description">{di.discordEmbedDescription}</Label>
              <Textarea
                id="panel-embed-description"
                value={panelEmbedDescription}
                onChange={(e) => setPanelEmbedDescription(e.target.value)}
                placeholder={st('sweep.welddesk.discordSettings.embedDescriptionPlaceholder')}
                rows={3}
                maxLength={4096}
                className="shadow-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="panel-embed-color">{di.discordEmbedColor}</Label>
                <div className="flex items-center gap-2">
                  <EmbedColorPicker value={panelEmbedColor} onChange={setPanelEmbedColor} />
                  <Input
                    value={panelEmbedColor}
                    onChange={(e) => setPanelEmbedColor(e.target.value)}
                    className="flex-1 shadow-none"
                    maxLength={7}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{di.discordButtonStyle}</Label>
                <Select
                  value={String(panelButtonStyle)}
                  onValueChange={(v) => setPanelButtonStyle(Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{di.discordButtonStylePrimary}</SelectItem>
                    <SelectItem value="3">{di.discordButtonStyleSuccess}</SelectItem>
                    <SelectItem value="2">{di.discordButtonStyleSecondary}</SelectItem>
                    <SelectItem value="4">{di.discordButtonStyleDanger}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="panel-button-text">{di.discordButtonText}</Label>
              <Input
                id="panel-button-text"
                value={panelButtonText}
                onChange={(e) => setPanelButtonText(e.target.value)}
                placeholder={st('sweep.welddesk.discordSettings.buttonLabelPlaceholder')}
                maxLength={80}
                className="shadow-none"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleSendPanel}
                disabled={!panelChannelId || postTicketPanelMutation.isPending}
              >
                {postTicketPanelMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    {di.discordSending}
                  </>
                ) : (
                  panelMessageId ? di.discordUpdatePanel : di.discordSendPanel
                )}
              </Button>
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
                <p>{di.discordNoTextChannels}</p>
                <p className="text-sm">{di.discordNoTextChannelsHint}</p>
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
                      "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                      isChannelEnabled(channel.channelId)
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
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
                <Label htmlFor="direct-messages">
                  {di.discordProcessDirectMessages}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {di.discordProcessDirectMessagesDesc}
                </p>
              </div>
              <Switch
                id="direct-messages"
                checked={processDirectMessages}
                onCheckedChange={setProcessDirectMessages}
              />
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="ignore-bots">{di.discordIgnoreBots}</Label>
                <p className="text-sm text-muted-foreground">
                  {di.discordIgnoreBotsDesc}
                </p>
              </div>
              <Switch
                id="ignore-bots"
                checked={ignoreBots}
                onCheckedChange={setIgnoreBots}
              />
            </div>

            <div className="space-y-2 mt-6 pt-6 border-t">
              <Label htmlFor="support-prefix">
                {di.discordSupportPrefix}
              </Label>
              <Input
                id="support-prefix"
                value={supportPrefix}
                onChange={(e) => setSupportPrefix(e.target.value)}
                placeholder={st('sweep.welddesk.discordSettings.triggerPlaceholder')}
                className="shadow-none"
              />
              <p className="text-sm text-muted-foreground">
                {di.discordSupportPrefixDesc}
              </p>
            </div>

            <div className="space-y-2 mt-6 pt-6 border-t">
              <Label htmlFor="auto-reply">
                {di.discordAutoReply}
              </Label>
              <Textarea
                id="auto-reply"
                value={autoReplyMessage}
                onChange={(e) => setAutoReplyMessage(e.target.value)}
                placeholder={st('sweep.welddesk.discordSettings.autoReplyPlaceholder')}
                rows={3}
                className="shadow-none"
              />
              <p className="text-sm text-muted-foreground">
                {di.discordAutoReplyDesc}
              </p>
            </div>
          </CardContent>
        </Card>
        )}

        {/* Save Button */}
        <div className="flex justify-end gap-2 sticky bottom-0 bg-background/95 backdrop-blur py-4 border-t">
          <Button
            variant="outline"
            className="shadow-none"
            onClick={handleCancel}
            disabled={!hasChanges || updateDiscordSettingsMutation.isPending}
          >
            {di.discordCancel}
          </Button>
          <Button
            className="shadow-none"
            onClick={handleSave}
            disabled={!hasChanges || updateDiscordSettingsMutation.isPending}
          >
            {updateDiscordSettingsMutation.isPending ? (
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
