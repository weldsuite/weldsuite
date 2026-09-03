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
  LayoutDashboard,
  Mail,
  MessagesSquare,
  Phone,
  SquareActivity,
  Users,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import { useNavigate } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { DrawerFieldSettings } from '@weldsuite/ui/components/drawer-field-settings';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
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
  icon: typeof LayoutDashboard;
  required?: boolean;
}> = [
  { id: 'overview', labelKey: 'sweep.entities.overviewTab', icon: LayoutDashboard, required: true },
  { id: 'common', labelKey: 'sweep.shared.common', icon: Users },
  { id: 'activity', labelKey: 'sweep.shared.activity', icon: SquareActivity },
];

// ─── Header ────────────────────────────────────────────────────────────────

function displayNameOf(p: MemberProfile | undefined, fallback: string): string {
  if (!p) return '';
  return p.name || p.email || fallback;
}

function MemberAvatar({ profile }: { profile?: MemberProfile }) {
  const t = useTranslations();
  const { getStatus } = usePresence();

  if (!profile) return <div className="h-7 w-7 rounded-lg bg-muted animate-pulse" />;

  const name = displayNameOf(profile, t('sweep.entities.teamMemberFallback'));
  const presence = getStatus(profile.userId);

  return (
    <div className="relative inline-flex">
      {/* Same treatment as PersonAvatar: h-7 w-7 rounded-lg, bordered, muted
          initial fallback. */}
      <Avatar className="h-7 w-7 rounded-lg border border-border">
        {profile.picture && (
          <AvatarImage src={profile.picture} alt={name} className="rounded-lg object-cover" />
        )}
        <AvatarFallback className="rounded-lg bg-muted text-[12px] font-medium">
          {(name.trim()[0] ?? '#').toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="absolute -bottom-0.5 -right-0.5">
        <StatusDot status={presence?.status ?? 'offline'} size="sm" showTooltip />
      </span>
    </div>
  );
}

function MemberTitle({ profile }: { profile?: MemberProfile }) {
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
      <span className="text-[15px] font-medium text-foreground truncate">
        {displayNameOf(profile, t('sweep.entities.teamMemberFallback'))}
      </span>
      {customStatus ? (
        <span className="text-xs text-muted-foreground truncate">{customStatus}</span>
      ) : null}
    </div>
  );
}

function MemberActions({ profile }: { profile?: MemberProfile }) {
  const t = useTranslations();
  const navigate = useNavigate();
  const compose = useComposeSafe();
  const callCtx = useWeldChatCallOptional();
  const dmQuery = useDmByUser(profile?.userId ?? '');
  const dmChannelId: string | undefined = dmQuery.data?.data?.id;
  const inCall = !!callCtx && callCtx.status !== 'idle' && callCtx.status !== 'ended';

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

  const iconButton = 'p-1.5 hover:bg-muted rounded-md transition-colors disabled:opacity-50 h-auto w-auto';

  return (
    <div className="flex items-center gap-0.5">
      {profile.email && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" className={iconButton} onClick={handleCompose} aria-label={t('sweep.entities.composeEmail')}>
              <Mail className="h-4 w-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('sweep.entities.composeEmail')}</TooltipContent>
        </Tooltip>
      )}
      {callCtx && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  className={iconButton}
                  onClick={() => handleCall('voice')}
                  disabled={!dmChannelId || inCall}
                  aria-label={t('sweep.entities.call')}
                >
                  <Phone className="h-4 w-4 text-muted-foreground" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('sweep.entities.call')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  className={iconButton}
                  onClick={() => handleCall('video')}
                  disabled={!dmChannelId || inCall}
                  aria-label={t('sweep.shared.videoCall')}
                >
                  <Video className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('sweep.shared.videoCall')}</TooltipContent>
          </Tooltip>
        </>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            className={iconButton}
            onClick={() => navigate({ to: '/weldchat/dm/$userId', params: { userId: profile.userId } })}
            aria-label={t('sweep.shared.openChat')}
          >
            <MessagesSquare className="h-4 w-4 text-muted-foreground" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('sweep.shared.openChat')}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="p-1.5 hover:bg-muted data-[state=open]:bg-muted rounded-md transition-colors focus:outline-none h-auto w-auto"
            aria-label={t('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onClick={() => navigate({ to: '/weldchat/dm/$userId', params: { userId: profile.userId } })}
          >
            {t('sweep.shared.openChat')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Tab bar ───────────────────────────────────────────────────────────────

function MemberPanelTabsBar({
  activeTab,
  setActiveTab,
  mode,
}: {
  activeTab: MemberTabId;
  setActiveTab: (id: MemberTabId) => void;
  mode: 'panel' | 'fullscreen';
}) {
  const t = useTranslations();

  const configEntries = useMemo(
    () =>
      MEMBER_TABS.map((tab) => ({
        id: tab.id,
        label: t(tab.labelKey),
        required: tab.required,
        defaultVisible: true,
      })),
    [t],
  );

  const { visibility, isVisible, toggle, resetToDefaults } = useObjectPanelTabConfig({
    objectType: 'team-member',
    mode,
    tabs: configEntries,
  });

  useEffect(() => {
    if (isVisible(activeTab)) return;
    const fallback = MEMBER_TABS.find((tab) => isVisible(tab.id));
    if (fallback && fallback.id !== activeTab) setActiveTab(fallback.id);
  }, [activeTab, isVisible, setActiveTab]);

  const tabs = useMemo(
    () =>
      MEMBER_TABS.filter((tab) => isVisible(tab.id)).map((tab) => ({
        id: tab.id,
        label: t(tab.labelKey),
        icon: tab.icon,
      })),
    [isVisible, t],
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

export function TeamMemberPanel(props: ObjectPanelComponentProps) {
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
        />
      }
    >
      {profile && activeTab === 'overview' && <OverviewTab profile={profile} />}
      {profile && activeTab === 'common' && <CommonTab userId={id} isSelf={isSelf} />}
      {profile && activeTab === 'activity' && <ActivityTab userId={id} canView />}
    </EntityDetailView>
  );
}
