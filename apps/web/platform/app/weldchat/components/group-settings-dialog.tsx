import * as React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@weldsuite/ui/components/breadcrumb';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@weldsuite/ui/components/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  Eye,
  Hash,
  ArrowDownUp,
  Settings as SettingsIcon,
  Search,
  RotateCcw,
  BellOff,
  Bell,
  ArrowDownAZ,
  ArrowDownZA,
  Clock,
  History,
  AlertCircle,
  AtSign,
  Phone,
  Archive as ArchiveIcon,
  VolumeX,
  CalendarPlus,
  CalendarClock,
  Eye as EyeIcon,
  EyeOff,
  Pin,
  Star,
  Inbox,
  CheckCheck,
  Moon,
  FileX,
  ChevronsDownUp,
  ChevronsUpDown,
  Zap,
  Copy,
} from 'lucide-react';
import {
  useUserPreferences,
  useUpdateUserPreferences,
} from '@/hooks/queries/use-settings-queries';
import { useMuteChannel, useUpdateChannel } from '@/hooks/queries/use-weldchat-queries';
import { Pencil } from 'lucide-react';
import {
  DEFAULT_GROUP_FILTER,
  type ActivityThreshold,
  type ChannelMode,
  type DayOfWeek,
  type DaySchedule,
  type GroupFilterSettings,
  type NotificationLevel,
  type SortBy,
  type WeldchatGroupFilters,
} from '../lib/group-filter';
import { useI18n } from '@/lib/i18n/provider';

export interface GroupSettingsTarget {
  groupKey: string;
  groupLabel: string;
  channels: Array<{
    id: string;
    name?: string | null;
    isMuted?: boolean | null;
    [key: string]: any;
  }>;
}

interface GroupSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: GroupSettingsTarget | null;
}

type SectionKey =
  | 'general'
  | 'visibility'
  | 'channels'
  | 'display'
  | 'notifications'
  | 'advanced';

export function GroupSettingsDialog({ open, onOpenChange, target }: GroupSettingsDialogProps) {
  const { t } = useI18n();

  const NAV: { key: SectionKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'general', label: t.weldchat.groupSettings.nav.general, icon: Pencil },
    { key: 'visibility', label: t.weldchat.groupSettings.nav.visibility, icon: Eye },
    { key: 'channels', label: t.weldchat.groupSettings.nav.channels, icon: Hash },
    { key: 'display', label: t.weldchat.groupSettings.nav.display, icon: ArrowDownUp },
    { key: 'notifications', label: t.weldchat.groupSettings.nav.notifications, icon: Bell },
    { key: 'advanced', label: t.weldchat.groupSettings.nav.advanced, icon: SettingsIcon },
  ];

  const { data: prefs } = useUserPreferences();
  const { mutate: updatePrefs, isPending } = useUpdateUserPreferences();
  const { mutate: muteChannel } = useMuteChannel();

  // Per-channel settings reuse this same dialog (target.groupKey starts with
  // `channel:`). Group-level concerns (Visibility filters, Channels picker,
  // Sort & display) don't apply to a single channel, so we narrow the nav.
  // The "General" section (rename, threads, attachments, slow mode, …) is
  // *only* shown for single-channel mode.
  const isSingleChannel = !!target?.groupKey?.startsWith('channel:');
  const visibleNav = useMemo(
    () =>
      isSingleChannel
        ? NAV.filter((n) => n.key === 'general' || n.key === 'notifications' || n.key === 'advanced')
        : NAV.filter((n) => n.key !== 'general'),
    [isSingleChannel],
  );

  const allFilters: WeldchatGroupFilters = (prefs?.uiPreferences as any)?.weldchatGroupFilters ?? {};
  const saved = target ? allFilters[target.groupKey] : undefined;

  const [draft, setDraft] = useState<GroupFilterSettings>({ ...DEFAULT_GROUP_FILTER, ...(saved ?? {}) });
  const [search, setSearch] = useState('');
  const [section, setSection] = useState<SectionKey>(isSingleChannel ? 'general' : 'visibility');
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);
  const [showResetPrompt, setShowResetPrompt] = useState(false);

  // ---- Channel-level (single-channel mode) draft + mutation ---------------
  const { mutate: updateChannel, isPending: isUpdatingChannel } = useUpdateChannel();
  const sourceChannel = isSingleChannel ? target?.channels?.[0] : null;
  type ChannelDraft = {
    name: string;
    description: string;
    topic: string;
    voiceCallsEnabled: boolean;
    videoCallsEnabled: boolean;
    threadsEnabled: boolean;
    attachmentsEnabled: boolean;
    reactionsEnabled: boolean;
    slowModeSeconds: number;
  };
  const channelBaseline = useMemo<ChannelDraft>(() => ({
    name: sourceChannel?.name ?? '',
    description: sourceChannel?.description ?? '',
    topic: sourceChannel?.topic ?? '',
    voiceCallsEnabled: sourceChannel?.voiceCallsEnabled ?? true,
    videoCallsEnabled: sourceChannel?.videoCallsEnabled ?? true,
    threadsEnabled: sourceChannel?.threadsEnabled ?? true,
    attachmentsEnabled: sourceChannel?.attachmentsEnabled ?? true,
    reactionsEnabled: sourceChannel?.reactionsEnabled ?? true,
    slowModeSeconds: sourceChannel?.slowModeSeconds ?? 0,
  }), [sourceChannel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [channelDraft, setChannelDraft] = useState<ChannelDraft>(channelBaseline);
  const channelDirty = useMemo(
    () => JSON.stringify(channelDraft) !== JSON.stringify(channelBaseline),
    [channelDraft, channelBaseline],
  );

  const baseline = useMemo<GroupFilterSettings>(
    () => ({ ...DEFAULT_GROUP_FILTER, ...(saved ?? {}) }),
    [saved],
  );
  const prefsDirty = useMemo(() => {
    return JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(baseline));
  }, [draft, baseline]);
  const isDirty = prefsDirty || channelDirty;

  useEffect(() => {
    if (open) {
      setDraft({ ...DEFAULT_GROUP_FILTER, ...(saved ?? {}) });
      setSearch('');
      setSection(isSingleChannel ? 'general' : 'visibility');
      setChannelDraft(channelBaseline);
    }
  }, [open, target?.groupKey, isSingleChannel, channelBaseline]);

  const update = <K extends keyof GroupFilterSettings>(key: K, value: GroupFilterSettings[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const sourceChannels = target?.channels ?? [];

  const channelIds = useMemo(() => new Set(draft.channelIds ?? []), [draft.channelIds]);
  const filteredSource = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sourceChannels;
    return sourceChannels.filter((c) => (c.name ?? '').toLowerCase().includes(q));
  }, [sourceChannels, search]);

  const visibleCount = useMemo(() => {
    const mode = draft.channelMode ?? 'all';
    if (mode === 'all') return sourceChannels.length;
    if (mode === 'include') return channelIds.size;
    return sourceChannels.length - channelIds.size;
  }, [draft.channelMode, channelIds, sourceChannels.length]);

  const toggleChannel = (id: string) => {
    const next = new Set(channelIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update('channelIds', Array.from(next));
  };

  const handleSave = () => {
    if (!target) return;

    // Save channel-level fields first (single-channel mode only).
    const saveChannel = () =>
      new Promise<void>((resolve) => {
        if (!isSingleChannel || !sourceChannel || !channelDirty) {
          resolve();
          return;
        }
        const diff: Record<string, unknown> = {};
        (Object.keys(channelDraft) as Array<keyof ChannelDraft>).forEach((k) => {
          if (channelDraft[k] !== channelBaseline[k]) diff[k] = channelDraft[k];
        });
        updateChannel(
          { channelId: sourceChannel.id, ...(diff as any) },
          { onSuccess: () => resolve(), onError: () => resolve() },
        );
      });

    // Then save user-prefs filter settings.
    const savePrefs = () =>
      new Promise<void>((resolve) => {
        if (!prefsDirty) {
          resolve();
          return;
        }
        const next: WeldchatGroupFilters = { ...allFilters, [target.groupKey]: draft };
        updatePrefs(
          { uiPreferences: { ...(prefs?.uiPreferences ?? {}), weldchatGroupFilters: next } as any },
          { onSuccess: () => resolve(), onError: () => resolve() },
        );
      });

    void saveChannel()
      .then(savePrefs)
      .then(() => onOpenChange(false));
  };

  const requestClose = () => {
    if (isDirty) {
      setShowUnsavedPrompt(true);
    } else {
      onOpenChange(false);
    }
  };

  const handleDiscard = () => {
    setShowUnsavedPrompt(false);
    setDraft(baseline);
    setChannelDraft(channelBaseline);
    onOpenChange(false);
  };

  const handleReset = () => {
    if (!target) return;
    const next = { ...allFilters };
    delete next[target.groupKey];
    setDraft({ ...DEFAULT_GROUP_FILTER });
    updatePrefs(
      { uiPreferences: { ...(prefs?.uiPreferences ?? {}), weldchatGroupFilters: next } as any },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  const handleMuteAll = () => {
    for (const ch of sourceChannels) {
      if (!ch.isMuted) muteChannel({ channelId: ch.id, mute: true });
    }
  };

  const handleUnmuteAll = () => {
    for (const ch of sourceChannels) {
      if (ch.isMuted) muteChannel({ channelId: ch.id, mute: false });
    }
  };

  const activeNav =
    visibleNav.find((n) => n.key === section) ?? visibleNav[0] ?? NAV[0];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          requestClose();
        } else {
          onOpenChange(true);
        }
      }}
    >
      <DialogContent
        className="overflow-hidden p-0 md:h-[600px] md:max-w-[800px] lg:max-w-[920px]"
        onEscapeKeyDown={(e) => {
          if (isDirty) {
            e.preventDefault();
            setShowUnsavedPrompt(true);
          }
        }}
        onPointerDownOutside={(e) => {
          if (isDirty) {
            e.preventDefault();
            setShowUnsavedPrompt(true);
          }
        }}
      >
        <DialogTitle className="sr-only">{target?.groupLabel ?? ''} {t.weldchat.groupSettings.header}</DialogTitle>
        <DialogDescription className="sr-only">
          Configure visibility, sorting, and notifications for this group.
        </DialogDescription>
        <SidebarProvider className="items-start !min-h-0 h-full">
          <Sidebar collapsible="none" className="hidden md:flex border-r">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {visibleNav.map((item) => (
                      <SidebarMenuItem key={item.key}>
                        <SidebarMenuButton
                          isActive={item.key === section}
                          onClick={() => setSection(item.key)}
                          className="data-[active=true]:bg-black/[0.03] data-[active=true]:font-medium dark:data-[active=true]:bg-white/[0.035]"
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex h-full flex-1 flex-col overflow-hidden">
            <header className="flex h-14 shrink-0 items-center gap-2 border-b">
              <div className="flex items-center gap-2 px-4">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <span className="text-muted-foreground">{target?.groupLabel ?? ''} {t.weldchat.groupSettings.header}</span>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>{activeNav.label}</BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>

            <div className="flex flex-1 flex-col overflow-y-auto p-5">
              {section === 'general' && isSingleChannel && (
                <div className="space-y-6">
                  {/* Identity */}
                  <div className="space-y-3">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.general.channelName}</Label>
                    <Input
                      value={channelDraft.name}
                      onChange={(e) =>
                        setChannelDraft((d) => ({ ...d, name: e.target.value }))
                      }
                      placeholder={t.weldchat.groupSettings.general.channelName}
                    />
                  </div>

                  <div className="space-y-3">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.general.topic}</Label>
                    <Input
                      value={channelDraft.topic}
                      onChange={(e) =>
                        setChannelDraft((d) => ({ ...d, topic: e.target.value }))
                      }
                      placeholder={t.weldchat.groupSettings.general.topicPlaceholder}
                    />
                  </div>

                  <div className="space-y-3">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.general.description}</Label>
                    <Textarea
                      value={channelDraft.description}
                      onChange={(e) =>
                        setChannelDraft((d) => ({ ...d, description: e.target.value }))
                      }
                      placeholder={t.weldchat.groupSettings.general.descriptionPlaceholder}
                      rows={3}
                    />
                  </div>

                  <Divider />

                  {/* Features */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.general.features}</Label>
                    <p className="text-xs text-muted-foreground pb-1">
                      {t.weldchat.groupSettings.general.featuresHint}
                    </p>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Label className="text-sm font-normal">{t.weldchat.groupSettings.general.threads}</Label>
                          <p className="text-xs text-muted-foreground">
                            {t.weldchat.groupSettings.general.threadsHint}
                          </p>
                        </div>
                        <Switch
                          checked={channelDraft.threadsEnabled}
                          onCheckedChange={(v) =>
                            setChannelDraft((d) => ({ ...d, threadsEnabled: !!v }))
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Label className="text-sm font-normal">{t.weldchat.groupSettings.general.attachments}</Label>
                          <p className="text-xs text-muted-foreground">
                            {t.weldchat.groupSettings.general.attachmentsHint}
                          </p>
                        </div>
                        <Switch
                          checked={channelDraft.attachmentsEnabled}
                          onCheckedChange={(v) =>
                            setChannelDraft((d) => ({ ...d, attachmentsEnabled: !!v }))
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Label className="text-sm font-normal">{t.weldchat.groupSettings.general.reactions}</Label>
                          <p className="text-xs text-muted-foreground">
                            {t.weldchat.groupSettings.general.reactionsHint}
                          </p>
                        </div>
                        <Switch
                          checked={channelDraft.reactionsEnabled}
                          onCheckedChange={(v) =>
                            setChannelDraft((d) => ({ ...d, reactionsEnabled: !!v }))
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Label className="text-sm font-normal">{t.weldchat.groupSettings.general.voiceCalls}</Label>
                          <p className="text-xs text-muted-foreground">
                            {t.weldchat.groupSettings.general.voiceCallsHint}</p>
                        </div>
                        <Switch
                          checked={channelDraft.voiceCallsEnabled}
                          onCheckedChange={(v) =>
                            setChannelDraft((d) => ({ ...d, voiceCallsEnabled: !!v }))
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <Label className="text-sm font-normal">{t.weldchat.groupSettings.general.videoCalls}</Label>
                          <p className="text-xs text-muted-foreground">
                            {t.weldchat.groupSettings.general.videoCallsHint}
                          </p>
                        </div>
                        <Switch
                          checked={channelDraft.videoCallsEnabled}
                          onCheckedChange={(v) =>
                            setChannelDraft((d) => ({ ...d, videoCallsEnabled: !!v }))
                          }
                        />
                      </div>
                    </div>
                  </div>

                  <Divider />

                  {/* Slow mode */}
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.general.slowMode}</Label>
                    <p className="text-xs text-muted-foreground pb-1">
                      {t.weldchat.groupSettings.general.slowModeHint}
                    </p>
                    <Select
                      value={String(channelDraft.slowModeSeconds)}
                      onValueChange={(v) =>
                        setChannelDraft((d) => ({ ...d, slowModeSeconds: Number(v) }))
                      }
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0">{t.weldchat.groupSettings.general.slowModeOff}</SelectItem>
                        <SelectItem value="5">{t.weldchat.groupSettings.general.slowMode5s}</SelectItem>
                        <SelectItem value="10">{t.weldchat.groupSettings.general.slowMode10s}</SelectItem>
                        <SelectItem value="30">{t.weldchat.groupSettings.general.slowMode30s}</SelectItem>
                        <SelectItem value="60">{t.weldchat.groupSettings.general.slowMode1m}</SelectItem>
                        <SelectItem value="300">{t.weldchat.groupSettings.general.slowMode5m}</SelectItem>
                        <SelectItem value="900">{t.weldchat.groupSettings.general.slowMode15m}</SelectItem>
                        <SelectItem value="3600">{t.weldchat.groupSettings.general.slowMode1h}</SelectItem>
                        <SelectItem value="21600">{t.weldchat.groupSettings.general.slowMode6h}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {section === 'visibility' && (
                <div className="space-y-4">
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.visibility.showOnly}</Label>
                    <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                      {t.weldchat.groupSettings.visibility.showOnlyHint}
                    </p>
                  </div>
                  <ToggleRow
                    id="show-only-unread"
                    label={t.weldchat.groupSettings.visibility.channelsWithUnread}
                    checked={!!draft.showOnlyUnread}
                    onChange={(v) => update('showOnlyUnread', v)}
                  />
                  <ToggleRow
                    id="show-only-mentions"
                    label={t.weldchat.groupSettings.visibility.channelsWithMentions}
                    checked={!!draft.showOnlyMentions}
                    onChange={(v) => update('showOnlyMentions', v)}
                  />
                  <ToggleRow
                    id="show-only-active-calls"
                    label={t.weldchat.groupSettings.visibility.channelsWithActiveCalls}
                    checked={!!draft.showOnlyActiveCalls}
                    onChange={(v) => update('showOnlyActiveCalls', v)}
                  />
                  <ToggleRow
                    id="show-only-pinned"
                    label={t.weldchat.groupSettings.visibility.pinnedChannels}
                    checked={!!draft.showOnlyPinned}
                    onChange={(v) => update('showOnlyPinned', v)}
                  />
                  <ToggleRow
                    id="show-only-favorited"
                    label={t.weldchat.groupSettings.visibility.favoritedChannels}
                    checked={!!draft.showOnlyFavorited}
                    onChange={(v) => update('showOnlyFavorited', v)}
                  />
                  <Divider />
                  <div className="space-y-1">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.visibility.hideChannels}</Label>
                  </div>
                  <ToggleRow
                    id="hide-muted"
                    label={t.weldchat.groupSettings.visibility.mutedChannels}
                    checked={!!draft.hideMuted}
                    onChange={(v) => {
                      update('hideMuted', v);
                      if (v) update('showOnlyMuted', false);
                    }}
                  />
                  <ToggleRow
                    id="show-only-muted"
                    label={t.weldchat.groupSettings.visibility.showOnlyMuted}
                    checked={!!draft.showOnlyMuted}
                    onChange={(v) => {
                      update('showOnlyMuted', v);
                      if (v) update('hideMuted', false);
                    }}
                  />
                  <ToggleRow
                    id="hide-archived"
                    label={t.weldchat.groupSettings.visibility.archivedChannels}
                    checked={!!draft.hideArchived}
                    onChange={(v) => update('hideArchived', v)}
                  />
                  <ToggleRow
                    id="hide-read"
                    label={t.weldchat.groupSettings.visibility.channelsNoUnread}
                    checked={!!draft.hideRead}
                    onChange={(v) => update('hideRead', v)}
                  />
                  <ToggleRow
                    id="hide-empty"
                    label={t.weldchat.groupSettings.visibility.channelsNoMessages}
                    checked={!!draft.hideEmpty}
                    onChange={(v) => update('hideEmpty', v)}
                  />
                  <ToggleRow
                    id="hide-without-topic"
                    label={t.weldchat.groupSettings.visibility.channelsNoTopic}
                    checked={!!draft.hideWithoutTopic}
                    onChange={(v) => update('hideWithoutTopic', v)}
                  />
                  <ToggleRow
                    id="hide-dms"
                    label={t.weldchat.groupSettings.visibility.directMessages}
                    checked={!!draft.hideDms}
                    onChange={(v) => update('hideDms', v)}
                  />
                  <Divider />
                  <div className="space-y-2">
                    <Label htmlFor="activity-threshold" className="text-sm font-medium">
                      {t.weldchat.groupSettings.visibility.activityThreshold}
                    </Label>
                    <Select
                      value={draft.activityThreshold ?? 'any'}
                      onValueChange={(v) => update('activityThreshold', v as ActivityThreshold)}
                    >
                      <SelectTrigger id="activity-threshold" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">{t.weldchat.groupSettings.visibility.activityAny}</SelectItem>
                        <SelectItem value="24h">{t.weldchat.groupSettings.visibility.activity24h}</SelectItem>
                        <SelectItem value="7d">{t.weldchat.groupSettings.visibility.activity7d}</SelectItem>
                        <SelectItem value="30d">{t.weldchat.groupSettings.visibility.activity30d}</SelectItem>
                        <SelectItem value="90d">{t.weldchat.groupSettings.visibility.activity90d}</SelectItem>
                        <SelectItem value="older1y">{t.weldchat.groupSettings.visibility.activityOlder1y}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Divider />
                  <ToggleRow
                    id="hide-when-empty"
                    label={t.weldchat.groupSettings.visibility.hideWhenEmpty}
                    checked={!!draft.hideWhenEmpty}
                    onChange={(v) => update('hideWhenEmpty', v)}
                  />
                </div>
              )}

              {section === 'channels' && (
                <div className="flex flex-1 flex-col gap-7 min-h-0">
                  <div className="space-y-1.5">
                    <Label htmlFor="channel-mode" className="text-sm font-medium">
                      {t.weldchat.groupSettings.channels.visibilityRule}
                    </Label>
                    <Select
                      value={draft.channelMode ?? 'all'}
                      onValueChange={(v) => update('channelMode', v as ChannelMode)}
                    >
                      <SelectTrigger id="channel-mode" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t.weldchat.groupSettings.channels.showAll}</SelectItem>
                        <SelectItem value="include">{t.weldchat.groupSettings.channels.showSelected}</SelectItem>
                        <SelectItem value="exclude">{t.weldchat.groupSettings.channels.showAllExcept}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                      {(draft.channelMode ?? 'all') === 'all'
                        ? t.weldchat.groupSettings.channels.everyChannelVisible
                        : (draft.channelMode === 'include'
                            ? `${channelIds.size} ${channelIds.size === 1 ? t.weldchat.groupSettings.channels.channelsWillBeShown : t.weldchat.groupSettings.channels.channelsWillBeShownPlural}`
                            : `${channelIds.size} ${channelIds.size === 1 ? t.weldchat.groupSettings.channels.channelsWillBeHidden : t.weldchat.groupSettings.channels.channelsWillBeHiddenPlural}`)}
                    </p>
                  </div>

                  <div className="flex flex-1 flex-col min-h-0 gap-2">
                    <div className="flex items-end justify-between">
                      <Label className="text-sm font-medium">
                        {t.weldchat.groupSettings.channels.channelsLabel}{' '}
                        <span className="font-normal text-muted-foreground">
                          ({visibleCount} {t.weldchat.groupSettings.channels.of} {sourceChannels.length} {t.weldchat.groupSettings.channels.visible})
                        </span>
                      </Label>
                      <div className="flex gap-3 text-xs text-muted-foreground">
                        <Button
                          type="button"
                          variant="ghost"
                          className="hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed h-auto p-0 text-xs font-normal text-muted-foreground"
                          disabled={(draft.channelMode ?? 'all') === 'all'}
                          onClick={() => update('channelIds', sourceChannels.map((c) => c.id))}
                        >
                          {t.weldchat.groupSettings.channels.selectAll}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed h-auto p-0 text-xs font-normal text-muted-foreground"
                          disabled={(draft.channelMode ?? 'all') === 'all' || channelIds.size === 0}
                          onClick={() => update('channelIds', [])}
                        >
                          {t.weldchat.groupSettings.channels.clear}
                        </Button>
                      </div>
                    </div>

                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder={t.weldchat.groupSettings.channels.searchChannels}
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-9 h-9"
                      />
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto">
                      {filteredSource.length === 0 ? (
                        <div className="border rounded-lg px-3 py-6 text-center text-sm text-muted-foreground bg-muted/20">
                          {sourceChannels.length === 0
                            ? t.weldchat.groupSettings.channels.noChannelsInGroup
                            : t.weldchat.groupSettings.channels.noChannelsMatch}
                        </div>
                      ) : (
                        <div className="border rounded-lg divide-y divide-border/50 overflow-hidden">
                          {filteredSource.map((ch) => {
                            const checked = channelIds.has(ch.id);
                            const disabled = (draft.channelMode ?? 'all') === 'all';
                            return (
                              <label
                                key={ch.id}
                                className={`flex items-center gap-3 px-3 py-2.5 text-sm transition-colors ${
                                  disabled
                                    ? 'cursor-not-allowed opacity-60'
                                    : 'cursor-pointer hover:bg-accent'
                                }`}
                              >
                                <Checkbox
                                  checked={checked}
                                  disabled={disabled}
                                  onCheckedChange={() => toggleChannel(ch.id)}
                                />
                                <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="flex-1 truncate">{ch.name || t.weldchat.groupSettings.channels.unnamed}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {section === 'display' && (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <div>
                      <Label className="text-sm font-medium">{t.weldchat.groupSettings.display.primarySort}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                        {t.weldchat.groupSettings.display.primarySortHint}
                      </p>
                    </div>
                    <SortOptionGrid
                      value={draft.sortBy ?? 'recent'}
                      onChange={(v) => update('sortBy', v)}
                    />
                  </div>

                  <Divider />

                  <div className="space-y-2">
                    <div>
                      <Label className="text-sm font-medium">{t.weldchat.groupSettings.display.moveToTop}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                        {t.weldchat.groupSettings.display.moveToTopHint}
                      </p>
                    </div>
                    <ChipToggleGroup
                      options={BOOST_OPTIONS.map((o) => ({ ...o, label: { boostActiveCall: t.weldchat.groupSettings.display.boostOptions.activeCalls, boostPinned: t.weldchat.groupSettings.display.boostOptions.pinned, boostFavorite: t.weldchat.groupSettings.display.boostOptions.favorited, boostMentions: t.weldchat.groupSettings.display.boostOptions.mentions, boostUnread: t.weldchat.groupSettings.display.boostOptions.unread }[o.key] ?? o.label }))}
                      isOn={(key) => !!draft[key]}
                      onToggle={(key) => update(key as any, !draft[key])}
                    />
                  </div>

                  <Divider />

                  <div className="space-y-2">
                    <div>
                      <Label className="text-sm font-medium">{t.weldchat.groupSettings.display.moveToBottom}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                        {t.weldchat.groupSettings.display.moveToBottomHint}
                      </p>
                    </div>
                    <ChipToggleGroup
                      options={SINK_OPTIONS.map((o) => ({ ...o, label: { sinkRead: t.weldchat.groupSettings.display.sinkOptions.alreadyRead, sinkInactive: t.weldchat.groupSettings.display.sinkOptions.inactive, sinkEmpty: t.weldchat.groupSettings.display.sinkOptions.noMessages, sinkMuted: t.weldchat.groupSettings.display.sinkOptions.muted, sinkArchived: t.weldchat.groupSettings.display.sinkOptions.archived }[o.key] ?? o.label }))}
                      isOn={(key) => !!draft[key]}
                      onToggle={(key) => update(key as any, !draft[key])}
                    />
                  </div>

                  <Divider />

                  <CollapseBehaviorSection draft={draft} update={update} setDraft={setDraft} />

                  <Divider />

                  <div className="space-y-2">
                    <div>
                      <div className="text-sm font-medium">{t.weldchat.groupSettings.display.channelLimit}</div>
                      <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                        {t.weldchat.groupSettings.display.channelLimitHint}
                      </p>
                    </div>
                    <Input
                      id="top-n"
                      type="number"
                      min={1}
                      placeholder={t.weldchat.groupSettings.display.allChannels}
                      value={draft.topN ?? ''}
                      onChange={(e) => {
                        const n = e.target.value === '' ? null : Number(e.target.value);
                        update('topN', n && n > 0 ? n : null);
                      }}
                      className="max-w-[200px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </div>
                </div>
              )}

              {section === 'notifications' && (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <div>
                      <Label className="text-sm font-medium">{t.weldchat.groupSettings.notifications.level}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                        {t.weldchat.groupSettings.notifications.levelHint}
                      </p>
                    </div>
                    <Select
                      value={draft.notificationLevel ?? 'all'}
                      onValueChange={(v) => update('notificationLevel', v as NotificationLevel)}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t.weldchat.groupSettings.notifications.allMessages}</SelectItem>
                        <SelectItem value="mentions">{t.weldchat.groupSettings.notifications.mentionsOnly}</SelectItem>
                        <SelectItem value="none">{t.weldchat.groupSettings.notifications.noNotifications}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Divider />

                  <div className="space-y-2">
                    <div>
                      <Label className="text-sm font-medium">{t.weldchat.groupSettings.notifications.sound}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                        {t.weldchat.groupSettings.notifications.soundHint}
                      </p>
                    </div>
                    <Select
                      value={draft.notificationSound ?? 'default'}
                      onValueChange={(v) => update('notificationSound', v as any)}
                    >
                      <SelectTrigger className="w-full max-w-[260px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">{t.weldchat.groupSettings.notifications.soundDefault}</SelectItem>
                        <SelectItem value="subtle">{t.weldchat.groupSettings.notifications.soundSubtle}</SelectItem>
                        <SelectItem value="chime">{t.weldchat.groupSettings.notifications.soundChime}</SelectItem>
                        <SelectItem value="silent">{t.weldchat.groupSettings.notifications.soundSilent}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <Divider />

                  <div className="space-y-3">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.notifications.delivery}</Label>
                    <div className="space-y-3">
                      <ToggleRow
                        id="desktop-notifs"
                        label={t.weldchat.groupSettings.notifications.desktopNotifications}
                        checked={!!draft.desktopNotifications}
                        onChange={(v) => update('desktopNotifications', v)}
                      />
                      <ToggleRow
                        id="play-sound"
                        label={t.weldchat.groupSettings.notifications.playSound}
                        checked={!!draft.playSound}
                        onChange={(v) => update('playSound', v)}
                      />
                      <ToggleRow
                        id="vibrate"
                        label={t.weldchat.groupSettings.notifications.vibrate}
                        checked={!!draft.vibrate}
                        onChange={(v) => update('vibrate', v)}
                      />
                      <ToggleRow
                        id="show-preview"
                        label={t.weldchat.groupSettings.notifications.showPreview}
                        checked={!!draft.showPreview}
                        onChange={(v) => update('showPreview', v)}
                      />
                      <ToggleRow
                        id="auto-mark-read"
                        label={t.weldchat.groupSettings.notifications.autoMarkRead}
                        checked={!!draft.autoMarkRead}
                        onChange={(v) => update('autoMarkRead', v)}
                      />
                    </div>
                  </div>

                  <Divider />

                  <QuietHoursSection draft={draft} update={update} setDraft={setDraft} />

                  <Divider />

                  <div className="space-y-2">
                    <Label className="text-sm font-medium">{t.weldchat.groupSettings.notifications.perChannel}</Label>
                    <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                      {t.weldchat.groupSettings.notifications.perChannelHint}
                    </p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {sourceChannels.filter((c) => !c.isMuted).length} of {sourceChannels.length} {t.weldchat.groupSettings.notifications.unmutedOf}
                      </span>
                      <div className="flex gap-3">
                        <Button
                          type="button"
                          variant="ghost"
                          className="hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed h-auto p-0 text-xs font-normal text-muted-foreground"
                          disabled={sourceChannels.every((c) => c.isMuted)}
                          onClick={handleMuteAll}
                        >
                          {t.weldchat.groupSettings.notifications.muteAll}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed h-auto p-0 text-xs font-normal text-muted-foreground"
                          disabled={sourceChannels.every((c) => !c.isMuted)}
                          onClick={handleUnmuteAll}
                        >
                          {t.weldchat.groupSettings.notifications.unmuteAll}
                        </Button>
                      </div>
                    </div>
                    {sourceChannels.length === 0 ? (
                      <div className="rounded-lg border bg-muted/20 px-3 py-6 text-center text-sm text-muted-foreground">
                        {t.weldchat.groupSettings.notifications.noChannelsInGroup}
                      </div>
                    ) : (
                      <div className="rounded-lg border divide-y divide-border/50 overflow-hidden">
                        {sourceChannels.map((ch) => (
                          <div
                            key={ch.id}
                            className="flex items-center gap-3 px-3 py-2.5 text-sm"
                          >
                            <Hash className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="flex-1 truncate">{ch.name || t.weldchat.groupSettings.channels.unnamed}</span>
                            <span className="text-[11px] text-muted-foreground">
                              {ch.isMuted ? t.weldchat.groupSettings.notifications.muted : t.weldchat.groupSettings.notifications.active}
                            </span>
                            <Switch
                              checked={!ch.isMuted}
                              onCheckedChange={(active) =>
                                muteChannel({ channelId: ch.id, mute: !active })
                              }
                              aria-label={ch.isMuted ? t.weldchat.groupSettings.notifications.unmuteChannel : t.weldchat.groupSettings.notifications.muteChannel}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {section === 'advanced' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <div>
                      <Label className="text-sm font-medium">{t.weldchat.groupSettings.advanced.reset}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
                        {t.weldchat.groupSettings.advanced.resetHint}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => setShowResetPrompt(true)}
                      disabled={isPending}
                      className="text-destructive hover:bg-destructive/5 hover:text-destructive hover:border-destructive/10 [&_svg]:!size-3.5"
                    >
                      <RotateCcw className="mr-0.5" />
                      {t.weldchat.groupSettings.advanced.resetButton}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <footer className="flex h-16 shrink-0 items-center justify-end gap-2 border-t px-4">
              <Button variant="outline" onClick={requestClose} disabled={isPending || isUpdatingChannel}>
                {t.weldchat.groupSettings.footer.cancel}
              </Button>
              <Button onClick={handleSave} disabled={isPending || isUpdatingChannel || !isDirty}>
                {isPending || isUpdatingChannel ? t.weldchat.groupSettings.footer.saving : t.weldchat.groupSettings.footer.save}
              </Button>
            </footer>
          </main>
        </SidebarProvider>
      </DialogContent>

      <AlertDialog open={showUnsavedPrompt} onOpenChange={setShowUnsavedPrompt}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.weldchat.groupSettings.unsavedChanges.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.weldchat.groupSettings.unsavedChanges.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.weldchat.groupSettings.unsavedChanges.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDiscard}>{t.weldchat.groupSettings.unsavedChanges.discard}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showResetPrompt} onOpenChange={setShowResetPrompt}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.weldchat.groupSettings.resetConfirm.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.weldchat.groupSettings.resetConfirm.description.replace('{group}', target?.groupLabel ?? t.weldchat.groupSettings.resetConfirm.thisGroup)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.weldchat.groupSettings.resetConfirm.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetPrompt(false);
                handleReset();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t.weldchat.groupSettings.resetConfirm.reset}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function normalize(s: GroupFilterSettings): GroupFilterSettings {
  return {
    ...s,
    channelIds: [...(s.channelIds ?? [])].sort(),
  };
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sm font-normal flex-1 cursor-pointer">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function RadioRow({ value, id, label }: { value: string; id: string; label: string }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 cursor-pointer text-sm">
      <RadioGroupItem value={value} id={id} />
      <span>{label}</span>
    </label>
  );
}

function Divider() {
  return <div className="border-t border-border/60 !my-4" />;
}

type CollapseMode = 'expanded' | 'collapsed' | 'peek';

const COLLAPSE_MODES: {
  value: CollapseMode;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    value: 'expanded',
    label: 'Always expanded',
    description: 'Every channel is visible.',
    icon: ChevronsUpDown,
  },
  {
    value: 'collapsed',
    label: 'Always collapsed',
    description: 'All channels hidden until you click the group.',
    icon: ChevronsDownUp,
  },
  {
    value: 'peek',
    label: 'Smart collapse',
    description: 'Hidden, but channels with activity peek through.',
    icon: Zap,
  },
];

const DEFAULT_DAY_SCHEDULE: DaySchedule = { enabled: true, start: '22:00', end: '08:00' };

function QuietHoursSection({
  draft,
  update,
  setDraft,
}: {
  draft: GroupFilterSettings;
  update: <K extends keyof GroupFilterSettings>(key: K, value: GroupFilterSettings[K]) => void;
  setDraft: React.Dispatch<React.SetStateAction<GroupFilterSettings>>;
}) {
  const { t } = useI18n();
  const d = t.weldchat.groupSettings.notifications.days;
  const translatedDays: { key: DayOfWeek; short: string; long: string }[] = [
    { key: 'mon', short: d.monShort, long: d.monLong },
    { key: 'tue', short: d.tueShort, long: d.tueLong },
    { key: 'wed', short: d.wedShort, long: d.wedLong },
    { key: 'thu', short: d.thuShort, long: d.thuLong },
    { key: 'fri', short: d.friShort, long: d.friLong },
    { key: 'sat', short: d.satShort, long: d.satLong },
    { key: 'sun', short: d.sunShort, long: d.sunLong },
  ];
  const schedule = draft.quietHoursSchedule ?? {};
  const getDay = (day: DayOfWeek): DaySchedule => schedule[day] ?? DEFAULT_DAY_SCHEDULE;

  const setDay = (day: DayOfWeek, patch: Partial<DaySchedule>) => {
    setDraft((d) => ({
      ...d,
      quietHoursSchedule: {
        ...(d.quietHoursSchedule ?? {}),
        [day]: { ...DEFAULT_DAY_SCHEDULE, ...(d.quietHoursSchedule?.[day] ?? {}), ...patch },
      },
    }));
  };

  const applyToAll = (source: DayOfWeek) => {
    const src = getDay(source);
    setDraft((d) => ({
      ...d,
      quietHoursSchedule: translatedDays.reduce<Partial<Record<DayOfWeek, DaySchedule>>>((acc, dDay) => {
        acc[dDay.key] = { ...src };
        return acc;
      }, {}),
    }));
  };

  const setAllEnabled = (enabled: boolean) => {
    setDraft((prev) => {
      const current = prev.quietHoursSchedule ?? {};
      const next: Partial<Record<DayOfWeek, DaySchedule>> = {};
      for (const day of translatedDays) {
        const existing = current[day.key] ?? DEFAULT_DAY_SCHEDULE;
        next[day.key] = { ...existing, enabled };
      }
      return { ...prev, quietHoursSchedule: next };
    });
  };

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-sm font-medium">{t.weldchat.groupSettings.notifications.quietHours}</Label>
        <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
          {t.weldchat.groupSettings.notifications.quietHoursHint}
        </p>
      </div>
      <ToggleRow
        id="quiet-hours"
        label={t.weldchat.groupSettings.notifications.enableQuietHours}
        checked={!!draft.quietHoursEnabled}
        onChange={(v) => update('quietHoursEnabled', v)}
      />
      {draft.quietHoursEnabled && (
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
            <Button
              type="button"
              variant="ghost"
              className="hover:text-foreground h-auto p-0 text-xs font-normal text-muted-foreground"
              onClick={() => setAllEnabled(true)}
            >
              {t.weldchat.groupSettings.notifications.enableAllDays}
            </Button>
            <span>·</span>
            <Button
              type="button"
              variant="ghost"
              className="hover:text-foreground h-auto p-0 text-xs font-normal text-muted-foreground"
              onClick={() => setAllEnabled(false)}
            >
              {t.weldchat.groupSettings.notifications.disableAllDays}
            </Button>
          </div>
          <div className="rounded-lg border divide-y divide-border/50">
            {translatedDays.map((day) => {
              const cfg = getDay(day.key);
              return (
                <div key={day.key} className="flex items-center gap-3 pl-4 pr-3 py-2.5">
                  <div className="w-10 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {day.short}
                  </div>
                  <div className="flex flex-1 items-center gap-2">
                    <Input
                      type="time"
                      value={cfg.start}
                      onChange={(e) => setDay(day.key, { start: e.target.value })}
                      disabled={!cfg.enabled}
                      className="w-[95px] [&::-webkit-calendar-picker-indicator]:scale-[1.05] [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:ml-2 [&::-webkit-calendar-picker-indicator]:mr-[-2px]"
                    />
                    <span className="text-xs text-muted-foreground">{t.weldchat.groupSettings.notifications.to}</span>
                    <Input
                      type="time"
                      value={cfg.end}
                      onChange={(e) => setDay(day.key, { end: e.target.value })}
                      disabled={!cfg.enabled}
                      className="w-[95px] [&::-webkit-calendar-picker-indicator]:scale-[1.05] [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:ml-2 [&::-webkit-calendar-picker-indicator]:mr-[-2px]"
                    />
                  </div>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => applyToAll(day.key)}
                          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                          aria-label={t.weldchat.groupSettings.notifications.copyScheduleToAllDays.replace('{day}', day.long)}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {t.weldchat.groupSettings.notifications.copyScheduleToAllDays.replace('{day}', day.long)}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <Switch
                    checked={cfg.enabled}
                    onCheckedChange={(v) => setDay(day.key, { enabled: v })}
                    aria-label={`${day.long} quiet hours enabled`}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CollapseBehaviorSection({
  draft,
  update,
  setDraft,
}: {
  draft: GroupFilterSettings;
  update: <K extends keyof GroupFilterSettings>(key: K, value: GroupFilterSettings[K]) => void;
  setDraft: React.Dispatch<React.SetStateAction<GroupFilterSettings>>;
}) {
  const { t } = useI18n();
  const mode: CollapseMode = !draft.collapsedByDefault
    ? 'expanded'
    : draft.peekActiveWhenCollapsed
      ? 'peek'
      : 'collapsed';

  const setMode = (next: CollapseMode) => {
    if (next === 'expanded') {
      setDraft((d) => ({ ...d, collapsedByDefault: false }));
    } else if (next === 'collapsed') {
      setDraft((d) => ({ ...d, collapsedByDefault: true, peekActiveWhenCollapsed: false }));
    } else {
      setDraft((d) => ({ ...d, collapsedByDefault: true, peekActiveWhenCollapsed: true }));
    }
  };

  const collapseModeLabels: Record<CollapseMode, { label: string; description: string }> = {
    expanded: {
      label: t.weldchat.groupSettings.display.alwaysExpanded,
      description: t.weldchat.groupSettings.display.alwaysExpandedDesc,
    },
    collapsed: {
      label: t.weldchat.groupSettings.display.alwaysCollapsed,
      description: t.weldchat.groupSettings.display.alwaysCollapsedDesc,
    },
    peek: {
      label: t.weldchat.groupSettings.display.smartCollapse,
      description: t.weldchat.groupSettings.display.smartCollapseDesc,
    },
  };

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-sm font-medium">{t.weldchat.groupSettings.display.collapseBehavior}</Label>
        <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
          {t.weldchat.groupSettings.display.collapseBehaviorHint}
        </p>
      </div>

      <Select value={mode} onValueChange={(v) => setMode(v as CollapseMode)}>
        <SelectTrigger className="w-full">
          <span>{collapseModeLabels[mode]?.label ?? collapseModeLabels.expanded.label}</span>
        </SelectTrigger>
        <SelectContent>
          {COLLAPSE_MODES.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <div className="flex flex-col">
                <span className="text-sm">{collapseModeLabels[opt.value].label}</span>
                <span className="text-[11px] text-muted-foreground">{collapseModeLabels[opt.value].description}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {mode === 'peek' && (
        <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
          <div>
            <Label className="text-sm font-medium">{t.weldchat.groupSettings.display.smartCollapseTriggers}</Label>
            <p className="text-xs text-muted-foreground mt-0.5 pb-[3px]">
              {t.weldchat.groupSettings.display.smartCollapseTriggersHint}
            </p>
          </div>

          <ChipToggleGroup
            options={PEEK_OPTIONS.map((o) => ({ ...o, label: { peekMentions: t.weldchat.groupSettings.display.peekOptions.mentions, peekUnread: t.weldchat.groupSettings.display.peekOptions.unreadMessages, peekActiveCalls: t.weldchat.groupSettings.display.peekOptions.activeCalls, peekPinned: t.weldchat.groupSettings.display.peekOptions.pinned, peekFavorited: t.weldchat.groupSettings.display.peekOptions.favorited, peekRecentlyActive: t.weldchat.groupSettings.display.peekOptions.recentlyActive }[o.key] ?? o.label }))}
            isOn={(key) => !!draft[key]}
            onToggle={(key) => update(key as any, !draft[key])}
          />

          {draft.peekRecentlyActive && (
            <div className="space-y-1.5">
              <Label htmlFor="peek-recent-window" className="text-xs uppercase tracking-wide text-muted-foreground">
                {t.weldchat.groupSettings.display.recentlyActiveWindow}
              </Label>
              <Select
                value={String(draft.peekRecentMinutes ?? 60)}
                onValueChange={(v) => update('peekRecentMinutes', Number(v))}
              >
                <SelectTrigger id="peek-recent-window" className="w-full max-w-[220px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">{t.weldchat.groupSettings.display.timeWindows.last5m}</SelectItem>
                  <SelectItem value="15">{t.weldchat.groupSettings.display.timeWindows.last15m}</SelectItem>
                  <SelectItem value="60">{t.weldchat.groupSettings.display.timeWindows.lastHour}</SelectItem>
                  <SelectItem value="240">{t.weldchat.groupSettings.display.timeWindows.last4h}</SelectItem>
                  <SelectItem value="1440">{t.weldchat.groupSettings.display.timeWindows.last24h}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="peek-max" className="text-xs uppercase tracking-wide text-muted-foreground">
              {t.weldchat.groupSettings.display.maxChannels}
            </Label>
            <Input
              id="peek-max"
              type="number"
              min={1}
              placeholder={t.weldchat.groupSettings.display.noLimit}
              value={draft.peekMaxItems ?? ''}
              onChange={(e) => {
                const n = e.target.value === '' ? null : Number(e.target.value);
                update('peekMaxItems', n != null && n > 0 ? n : null);
              }}
              className="max-w-[220px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

const SORT_OPTIONS: { value: SortBy; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'name-asc', label: 'A → Z', icon: ArrowDownAZ },
  { value: 'name-desc', label: 'Z → A', icon: ArrowDownZA },
  { value: 'recent', label: 'Recent activity', icon: Clock },
  { value: 'oldest', label: 'Oldest activity', icon: History },
  { value: 'newest-channel', label: 'Newest channel', icon: CalendarPlus },
  { value: 'oldest-channel', label: 'Oldest channel', icon: CalendarClock },
  { value: 'last-opened', label: 'Last opened', icon: EyeIcon },
  { value: 'least-opened', label: 'Least opened', icon: EyeOff },
  { value: 'unread-count', label: 'Most unread', icon: Inbox },
  { value: 'mentions-count', label: 'Most mentions', icon: AtSign },
];

type BoostKey =
  | 'boostActiveCall'
  | 'boostPinned'
  | 'boostFavorite'
  | 'boostMentions'
  | 'boostUnread';

type SinkKey =
  | 'sinkRead'
  | 'sinkInactive'
  | 'sinkEmpty'
  | 'sinkMuted'
  | 'sinkArchived';

type PeekKey =
  | 'peekMentions'
  | 'peekUnread'
  | 'peekActiveCalls'
  | 'peekPinned'
  | 'peekFavorited'
  | 'peekRecentlyActive';

const BOOST_OPTIONS: { key: BoostKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'boostActiveCall', label: 'Active calls', icon: Phone },
  { key: 'boostPinned', label: 'Pinned', icon: Pin },
  { key: 'boostFavorite', label: 'Favorited', icon: Star },
  { key: 'boostMentions', label: 'Mentions', icon: AtSign },
  { key: 'boostUnread', label: 'Unread', icon: AlertCircle },
];

const SINK_OPTIONS: { key: SinkKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'sinkRead', label: 'Already read', icon: CheckCheck },
  { key: 'sinkInactive', label: 'Inactive 30+ days', icon: Moon },
  { key: 'sinkEmpty', label: 'No messages yet', icon: FileX },
  { key: 'sinkMuted', label: 'Muted', icon: VolumeX },
  { key: 'sinkArchived', label: 'Archived', icon: ArchiveIcon },
];

const PEEK_OPTIONS: { key: PeekKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'peekMentions', label: 'Mentions', icon: AtSign },
  { key: 'peekUnread', label: 'Unread messages', icon: AlertCircle },
  { key: 'peekActiveCalls', label: 'Active calls', icon: Phone },
  { key: 'peekPinned', label: 'Pinned', icon: Pin },
  { key: 'peekFavorited', label: 'Favorited', icon: Star },
  { key: 'peekRecentlyActive', label: 'Recently active', icon: Clock },
];

function SortOptionGrid({ value, onChange }: { value: SortBy; onChange: (v: SortBy) => void }) {
  const { t } = useI18n();
  const sortLabels: Record<string, string> = {
    'name-asc': t.weldchat.groupSettings.display.sortOptions.nameAsc,
    'name-desc': t.weldchat.groupSettings.display.sortOptions.nameDesc,
    'recent': t.weldchat.groupSettings.display.sortOptions.recent,
    'oldest': t.weldchat.groupSettings.display.sortOptions.oldest,
    'newest-channel': t.weldchat.groupSettings.display.sortOptions.newestChannel,
    'oldest-channel': t.weldchat.groupSettings.display.sortOptions.oldestChannel,
    'last-opened': t.weldchat.groupSettings.display.sortOptions.lastOpened,
    'least-opened': t.weldchat.groupSettings.display.sortOptions.leastOpened,
    'unread-count': t.weldchat.groupSettings.display.sortOptions.unreadCount,
    'mentions-count': t.weldchat.groupSettings.display.sortOptions.mentionsCount,
  };
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {SORT_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = value === opt.value;
        return (
          <Button
            key={opt.value}
            type="button"
            variant="ghost"
            onClick={() => onChange(opt.value)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors h-auto font-normal ${
              active
                ? 'border-primary bg-primary/5 text-foreground font-medium'
                : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{sortLabels[opt.value] ?? opt.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

function ChipToggleGroup<K extends string>({
  options,
  isOn,
  onToggle,
}: {
  options: { key: K; label: string; icon: React.ComponentType<{ className?: string }> }[];
  isOn: (key: K) => boolean;
  onToggle: (key: K) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const Icon = opt.icon;
        const active = isOn(opt.key);
        return (
          <Button
            key={opt.key}
            type="button"
            variant="ghost"
            onClick={() => onToggle(opt.key)}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors h-auto font-normal ${
              active
                ? 'border-primary bg-primary/5 text-foreground font-medium'
                : 'border-border hover:bg-accent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{opt.label}</span>
          </Button>
        );
      })}
    </div>
  );
}

