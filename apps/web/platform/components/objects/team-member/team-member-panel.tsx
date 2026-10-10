/**
 * Team-member object panel.
 *
 * Structural peer of the WeldCRM person panel (components/objects/person/
 * person-panel.tsx): the same `EntityDetailView` shell, the same
 * `ObjectPanelTabs` strip with per-user tab visibility via
 * `useObjectPanelTabConfig`, and the same avatar / title / actions header
 * treatment — so it stacks, expands and reads identically to Person, Company
 * and Channel rather than being a bespoke fixed-position drawer.
 *
 * Tab bodies are the shared components under `components/team-member-panel/
 * tabs/`, which the older drawer also renders, so both surfaces show the same
 * content and there is one place to change it.
 *
 * Reads through `useMemberProfile` (not the panel-local `useTeamMemberProfile`)
 * on purpose: `useUpdateMemberProfile` — which the inline-editable rows in the
 * Details tab commit through — invalidates that query key. Reading from the
 * other key would leave an edit on screen unrefreshed.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/clerk-react';
import {
  EllipsisVertical,
  ChartNoAxesGantt,
  Mail,
  MessagesSquare,
  Phone,
  SquareActivity,
  HeartHandshake,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { StatusDot } from '@weldsuite/ui/components/status-dot';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  useObjectPanelTabConfig,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { usePresence } from '@/contexts/presence-context';
import { useComposeSafe } from '@/contexts/compose-context';
import { useMemberProfile } from '@/hooks/queries/use-team-queries';
import { useDmByUser } from '@/hooks/queries/use-weldchat-queries';
import { useWeldChatCallOptional } from '@/contexts/weldchat-call-context';
import { OverviewTab } from '@/components/team-member-panel/tabs/overview-tab';
import { CommonTab } from '@/components/team-member-panel/tabs/common-tab';
import { ActivityTab } from '@/components/team-member-panel/tabs/activity-tab';
import type { MemberProfile } from '@weldsuite/core-api-client/schemas/member-profile';

// Matches PERSON_PANEL_WIDTH so a member panel stacked beside a person panel
// lines up instead of stepping.
const TEAM_MEMBER_PANEL_WIDTH = 400;

type MemberTabId = 'overview' | 'common' | 'activity';

const MEMBER_TABS: Array<{
  id: MemberTabId;
  labelKey: string;
  icon: typeof ChartNoAxesGantt;
  required?: boolean;
}> = [
  { id: 'overview', labelKey: 'sweep.entities.overviewTab', icon: ChartNoAxesGantt, required: true },
  { id: 'common', labelKey: 'sweep.shared.common', icon: HeartHandshake },
  { id: 'activity', labelKey: 'sweep.shared.activity', icon: SquareActivity },
];

// ─── Header ────────────────────────────────────────────────────────────────

function displayNameOf(p: MemberProfile | undefined, fallback: string): string {
  if (!p) return '';
  return p.name || p.email || fallback;
}

function MemberAvatar({ profile }: Readonly<{ profile?: MemberProfile }>) {
  const t = useTranslations();
  const { getStatus } = usePresence();

  if (!profile) return <div className="size-[22px] rounded-[8px] bg-muted animate-pulse" />;

  const name = displayNameOf(profile, t('sweep.entities.teamMemberFallback'));
  const presence = getStatus(profile.userId);

  // `flex` (not `inline-flex`): an inline box sits in a text line and makes the
  // wrapper taller than the avatar, which stretched the whole header row.
  return (
    <div className="relative flex">
      {/* 22×22 rounded square, muted initial fallback. No border, so the
          picture itself is the full 22px. */}
      <Avatar className="size-[22px] !rounded-[8px]">
        {profile.picture && (
          <AvatarImage src={profile.picture} alt={name} className="!rounded-[8px] object-cover" />
        )}
        <AvatarFallback className="!rounded-[8px] bg-muted text-[10px] font-medium">
          {(name.trim()[0] ?? '#').toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="absolute -bottom-0.5 -right-0.5">
        <StatusDot status={presence?.status ?? 'offline'} size="sm" showTooltip />
      </span>
    </div>
  );
}

function MemberTitle({ profile }: Readonly<{ profile?: MemberProfile }>) {
  const t = useTranslations();
  const { getStatus } = usePresence();

  if (!profile) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;

  const presence = getStatus(profile.userId);
  const customStatus =
    presence?.statusText || presence?.statusEmoji
      ? `${presence.statusEmoji ?? ''} ${presence.statusText ?? ''}`.trim()
      : null;

  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[15px] font-medium leading-6 text-foreground truncate">
        {displayNameOf(profile, t('sweep.entities.teamMemberFallback'))}
      </span>
      {customStatus ? (
        <span className="text-xs text-muted-foreground truncate">{customStatus}</span>
      ) : null}
    </div>
  );
}

function MemberActions({ profile }: Readonly<{ profile?: MemberProfile }>) {
  const t = useTranslations();
  const navigate = useNavigate();
  const compose = useComposeSafe();
  const callCtx = useWeldChatCallOptional();
  const dmQuery = useDmByUser(profile?.userId ?? '');
  const dmChannelId: string | undefined = dmQuery.data?.data?.id;

  if (!profile) return null;

  const handleCompose = () => {
    if (!profile.email) return;
    if (compose) {
      compose.openCompose({ to: profile.email });
      return;
    }
    window.location.href = `mailto:${profile.email}`;
  };

  const handleCall = async (kind: 'voice' | 'video') => {
    if (!callCtx || !dmChannelId) return;
    try {
      await callCtx.startCall(dmChannelId, kind);
    } catch {
      toast.error(t('sweep.shared.startCallFailed'));
    }
  };

  // Mail, call, video and chat all live in the "⋮" menu, so the header only
  // carries that one button next to the shell's Expand / Close.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
          aria-label={t('sweep.entities.moreActions')}
        >
          <EllipsisVertical className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {profile.email && (
          <DropdownMenuItem onClick={handleCompose}>
            <Mail />
            {t('sweep.entities.composeEmail')}
          </DropdownMenuItem>
        )}
        {callCtx && (
          <>
            <DropdownMenuItem disabled={!dmChannelId} onClick={() => handleCall('voice')}>
              <Phone />
              {t('sweep.entities.call')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!dmChannelId} onClick={() => handleCall('video')}>
              <Video />
              {t('sweep.shared.videoCall')}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuItem
          onClick={() => navigate({ to: '/weldchat/dm/$userId', params: { userId: profile.userId } })}
        >
          <MessagesSquare />
          {t('sweep.shared.openChat')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function MemberPanelTabsBar({
  activeTab,
  setActiveTab,
  mode,
  isSelf,
}: Readonly<{
  activeTab: MemberTabId;
  setActiveTab: (id: MemberTabId) => void;
  mode: 'panel' | 'fullscreen';
  /** Viewing your own profile: there is nothing "in common" with yourself, so that tab is left out. */
  isSelf: boolean;
}>) {
  const t = useTranslations();

  const availableTabs = useMemo(
    () => MEMBER_TABS.filter((tab) => !(isSelf && tab.id === 'common')),
    [isSelf],
  );

  const configEntries = useMemo(
    () =>
      availableTabs.map((tab) => ({
        id: tab.id,
        label: t(tab.labelKey),
        required: tab.required,
        defaultVisible: true,
      })),
    [availableTabs, t],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType: 'team-member',
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (availableTabs.some((tab) => tab.id === activeTab) && isVisible(activeTab)) return;
    const fallback = availableTabs.find((tab) => isVisible(tab.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, availableTabs, isVisible, setActiveTab]);

  const tabs = useMemo(
    () =>
      availableTabs.filter((tab) => isVisible(tab.id)).map((tab) => ({
        id: tab.id,
        label: t(tab.labelKey),
        icon: tab.icon,
      })),
    [availableTabs, isVisible, t],
  );

  return (
    <div className="group/tabs-header relative">
      <ObjectPanelTabs
        tabs={tabs}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as MemberTabId)}
      />
      <div className="absolute top-0 right-2 h-full flex items-center opacity-0 group-hover/tabs-header:opacity-100 focus-within:opacity-100 transition-opacity">
        <DrawerFieldSettings
          fields={configEntries}
          fieldVisibility={visibility}
          onToggle={toggle}
          onReset={resetToDefaults}
          label={t('sweep.entities.visibleTabs')}
        />
      </div>
    </div>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function TeamMemberPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { userId: viewerUserId } = useAuth();
  const profileQuery = useMemberProfile(id);
  const profile = profileQuery.data;

  const shell = useObjectPanelShell({
    ...props,
    width: TEAM_MEMBER_PANEL_WIDTH,
    loading: profileQuery.isLoading && !profile,
  });

  const initial: MemberTabId = useMemo(() => {
    if (initialTab && MEMBER_TABS.some((tab) => tab.id === initialTab)) {
      return initialTab as MemberTabId;
    }
    return 'overview';
  }, [initialTab]);
  const [activeTab, setActiveTab] = useState<MemberTabId>(initial);

  const isSelf = !!viewerUserId && viewerUserId === id;

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      avatar={<MemberAvatar profile={profile} />}
      title={<MemberTitle profile={profile} />}
      actions={<MemberActions profile={profile} />}
      tabs={
        <MemberPanelTabsBar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          mode={shell.mode}
          isSelf={isSelf}
        />
      }
    >
      {profile && activeTab === 'overview' && <OverviewTab profile={profile} />}
      {profile && activeTab === 'common' && !isSelf && <CommonTab userId={id} isSelf={isSelf} />}
      {profile && activeTab === 'activity' && (
        <ActivityTab userId={id} canView memberName={profile.name || undefined} />
      )}
    </EntityDetailView>
  );
}
