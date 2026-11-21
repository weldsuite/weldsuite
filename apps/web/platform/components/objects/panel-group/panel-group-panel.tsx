/**
 * WeldPanel group object panel: the record view of a group (a company, a
 * workspace…) a project's events belong to, built like the WeldPanel person
 * panel and the other record panels: the `EntityDetailView` shell from
 * `useObjectPanelShell`, an avatar + name header with the WeldCRM link and
 * the "⋮" menu, the icon tab strip, and tabs of property rows and standard
 * list rows.
 *
 * It replaces the standalone `/weldpanel/groups/:type/:key` page, which now
 * redirects to the Groups list with this panel open in fullscreen.
 *
 * Tabs: Details (type, key, when seen, counts, every property) · Members (the
 * people who carried it; a row opens their panel) · Activity (recent events).
 */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarClock,
  CalendarPlus,
  EllipsisVertical,
  Hash,
  KeyRound,
  Layers,
  SquareArrowOutUpRight,
  Tag,
  Trash2,
  Users,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelGroupMemberDto, PanelGroupProfileDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import type { PanelActivityEvent } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { ObjectPanelTabs, useObjectPanel, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { PanelRow, PanelSection, RecordLoadFailed } from '@/components/objects/_shared/record-panel-parts';
import { ActivityIllustration, PeopleIllustration, TAB_EMPTY_STATE_TABLE_CLASS, tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { PANEL_PERSON_TYPE, panelPersonId } from '@/components/objects/panel-person/panel-person-tabs';
import { useDeleteWeldPanelGroup, useWeldPanelGroup, useWeldPanelGroupTypes } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { isNotFoundError } from '@/app/weldpanel/lib/api-errors';
import { formatDateTime, formatNumber } from '@/app/weldpanel/lib/format';
import { propertyText } from '@/app/weldpanel/lib/people';
import { useCurrentProject } from '@/app/weldpanel/lib/use-current-project';
import { PANEL_GROUP_TAB_ICONS, isPanelGroupTabId, parsePanelGroupId, type PanelGroupTabId } from './panel-group-tabs';

const PANEL_GROUP_WIDTH = 400;

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase() || '#';
}

// ─── Header ────────────────────────────────────────────────────────────────

function GroupPanelAvatar({ name }: Readonly<{ name?: string }>) {
  if (!name) return <div className="size-[22px] animate-pulse rounded-[32%] bg-muted" />;
  return (
    <Avatar className="size-[22px]">
      <AvatarFallback className="bg-muted text-[10px] font-medium">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

function GroupPanelTitle({ name }: Readonly<{ name?: string }>) {
  if (!name) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />;
  return <span className="block truncate text-[15px] font-medium leading-6 text-foreground">{name}</span>;
}

/** The header actions: the matching WeldCRM company, and the "⋮" menu with Delete. */
function GroupPanelActions({
  crmCompanyId,
  canDelete,
  onDelete,
}: Readonly<{ crmCompanyId: string | null; canDelete: boolean; onDelete: () => void }>) {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const tp = t.weldpanel.explore.groups.profile;
  return (
    <>
      {crmCompanyId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={() => router.push(`/weldcrm/companies?stack=company:${encodeURIComponent(crmCompanyId)}:panel`)}
              aria-label={tp.openInCrm}
            >
              <SquareArrowOutUpRight className="size-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tp.openInCrm}</TooltipContent>
        </Tooltip>
      )}
      {canDelete && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
              aria-label={st('sweep.entities.moreActions')}
            >
              <EllipsisVertical className="size-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 />
              {tp.delete}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

function DetailsTab({ profile, typeName }: Readonly<{ profile: PanelGroupProfileDto; typeName: string }>) {
  const { t, language, format } = useI18n();
  const tp = t.weldpanel.explore.groups.profile;
  const { group } = profile;
  const properties = Object.entries(group.properties).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="space-y-5 p-4">
      {!profile.hasProfile && <InfoBanner variant="info">{tp.noProfile}</InfoBanner>}
      <div className="space-y-1">
        <PanelRow icon={Layers} label={t.weldpanel.explore.groups.type} value={typeName} />
        <PanelRow icon={KeyRound} label={t.weldpanel.explore.groups.columns.key} value={group.groupKey} />
        <PanelRow icon={CalendarPlus} label={tp.firstSeen} value={formatDateTime(group.firstSeen, language)} />
        <PanelRow icon={CalendarClock} label={tp.lastSeen} value={formatDateTime(group.lastSeen, language)} />
        <PanelRow icon={Hash} label={format(tp.events, { days: profile.days })} value={formatNumber(profile.eventCount, language)} tabular />
        <PanelRow icon={Users} label={format(tp.members, { days: profile.days })} value={formatNumber(profile.memberCount, language)} tabular />
      </div>
      <PanelSection title={tp.tabs.properties}>
        {properties.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tp.noProperties}</p>
        ) : (
          <div className="space-y-1">
            {properties.map(([key, value]) => (
              <PanelRow key={key} icon={Tag} label={key} value={propertyText(value)} />
            ))}
          </div>
        )}
      </PanelSection>
    </div>
  );
}

type MemberRow = PanelGroupMemberDto & { id: string };

const MEMBER_COLUMN = {
  person: 'min-w-0 flex-1',
  lastSeen: 'w-[170px] @max-[560px]:w-[130px]',
  events: 'w-[80px] text-right @max-[560px]:hidden',
};

function MembersTab({ profile, projectId }: Readonly<{ profile: PanelGroupProfileDto; projectId: string }>) {
  const { t, language } = useI18n();
  const tp = t.weldpanel.explore.groups.profile;
  const canReadPeople = useCan('panel_people:read');
  const { open: openPanel } = useObjectPanel();
  const items = useMemo<MemberRow[]>(() => profile.members.map((member) => ({ ...member, id: member.distinctId })), [profile.members]);
  const headerColumns: HeaderColumn[] = [
    { id: 'person', header: tp.memberColumns.person, width: MEMBER_COLUMN.person },
    { id: 'lastSeen', header: tp.memberColumns.lastSeen, width: MEMBER_COLUMN.lastSeen },
    { id: 'events', header: tp.memberColumns.events, width: MEMBER_COLUMN.events, className: 'text-right' },
  ];
  return (
    <TabListScope>
      <EntityList<MemberRow>
        items={items}
        isLoading={false}
        error={null}
        filters={[]}
        hideFilter
        headerColumns={headerColumns}
        renderRow={(member) => (
          <TabListRow
            key={member.id}
            label={member.distinctId}
            // A person opens on top of the group, with a back arrow to return.
            onOpen={canReadPeople ? () => openPanel({ type: PANEL_PERSON_TYPE, id: panelPersonId(projectId, member.distinctId), stack: true }) : undefined}
          >
            <div className={`${MEMBER_COLUMN.person} flex items-center gap-2`}>
              <Avatar className="h-[18px] w-[18px] flex-shrink-0">
                <AvatarFallback className="bg-gray-200 text-[9px] font-medium text-gray-600 dark:bg-accent dark:text-muted-foreground">
                  {(member.distinctId.trim()[0] ?? '?').toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-sm font-medium text-foreground">{member.distinctId}</span>
            </div>
            <div className={`${MEMBER_COLUMN.lastSeen} whitespace-nowrap text-sm tabular-nums text-muted-foreground`}>{formatDateTime(member.lastSeen, language)}</div>
            <div className={`${MEMBER_COLUMN.events} text-sm tabular-nums`}>{formatNumber(member.eventCount, language)}</div>
          </TabListRow>
        )}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <PeopleIllustration />, title: tp.tabs.members, description: tp.noMembers }}
      />
    </TabListScope>
  );
}

type EventRow = PanelActivityEvent & { id: string };

const EVENT_COLUMN = {
  name: 'min-w-0 flex-1',
  page: 'w-[200px] @max-[560px]:hidden',
  time: 'w-[150px] @max-[560px]:w-[120px]',
};

function ActivityTab({ events }: Readonly<{ events: PanelActivityEvent[] }>) {
  const { t, language } = useI18n();
  const tp = t.weldpanel.explore.groups.profile;
  const items = useMemo<EventRow[]>(() => events.map((event) => ({ ...event, id: event.eventId })), [events]);
  const headerColumns: HeaderColumn[] = [
    { id: 'name', header: tp.activityColumns.event, width: EVENT_COLUMN.name },
    { id: 'page', header: tp.activityColumns.page, width: EVENT_COLUMN.page },
    { id: 'time', header: tp.activityColumns.time, width: EVENT_COLUMN.time },
  ];
  return (
    <TabListScope>
      <EntityList<EventRow>
        items={items}
        isLoading={false}
        error={null}
        filters={[]}
        hideFilter
        headerColumns={headerColumns}
        renderRow={(event) => (
          <TabListRow key={event.id} label={event.name}>
            <div className={`${EVENT_COLUMN.name} truncate text-sm font-medium text-foreground`}>{event.name}</div>
            <div className={`${EVENT_COLUMN.page} truncate text-sm text-muted-foreground`} title={event.url ?? undefined}>
              {event.path ?? '—'}
            </div>
            <div className={`${EVENT_COLUMN.time} whitespace-nowrap text-sm tabular-nums text-muted-foreground`}>{formatDateTime(event.ts, language)}</div>
          </TabListRow>
        )}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <ActivityIllustration />, title: tp.tabs.activity, description: tp.noActivity }}
      />
    </TabListScope>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function PanelGroupPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { t, format } = useI18n();
  const st = useTranslations();
  const { id, onClose, initialTab } = props;
  const tx = t.weldpanel.explore.groups;
  const tp = tx.profile;
  const parsed = parsePanelGroupId(id);
  const { project } = useCurrentProject();
  // A link without a project shows the group in the project picked in the sidebar.
  const projectId = parsed.projectId || project?.id || '';
  const { groupType, groupKey } = parsed;

  const canDelete = useCan('panel_people:delete');
  const query = useWeldPanelGroup(projectId, groupType, groupKey);
  const profile = query.data;
  const { data: types } = useWeldPanelGroupTypes(projectId);
  const remove = useDeleteWeldPanelGroup(projectId);
  const name = profile ? profile.group.name?.trim() || profile.group.groupKey : undefined;
  const typeName = types?.find((g) => g.groupType === groupType)?.nameSingular ?? groupType;

  const shell = useObjectPanelShell({ ...props, width: PANEL_GROUP_WIDTH, loading: query.isLoading && !profile });
  const mode = shell.mode;

  const [activeTab, setActiveTab] = useState<PanelGroupTabId>(() => (isPanelGroupTabId(initialTab) ? initialTab : 'overview'));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tabs = useMemo(
    () =>
      (['overview', 'members', 'activity'] as const).map((tabId) => ({
        id: tabId,
        label: tabId === 'overview' ? st('sweep.entities.detailsTab') : tp.tabs[tabId],
        icon: PANEL_GROUP_TAB_ICONS[tabId],
        count: tabId === 'members' && profile && profile.memberCount > 0 ? profile.memberCount : undefined,
      })),
    [st, tp.tabs, profile],
  );

  async function handleDelete() {
    try {
      await remove.mutateAsync({ groupType, groupKey });
      toast.success(tp.deleted);
      setConfirmDelete(false);
      onClose();
    } catch {
      toast.error(tp.deleteFailed);
    }
  }

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(mode)}
      avatar={<GroupPanelAvatar name={name} />}
      title={<GroupPanelTitle name={name} />}
      actions={
        profile ? (
          <GroupPanelActions crmCompanyId={profile.crmCompany?.id ?? null} canDelete={canDelete && profile.hasProfile} onDelete={() => setConfirmDelete(true)} />
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={tabs} activeTab={activeTab} onChange={(tabId) => setActiveTab(tabId as PanelGroupTabId)} />}
    >
      {!profile && query.isError && (
        <RecordLoadFailed
          notFound={isNotFoundError(query.error)}
          message={isNotFoundError(query.error) ? tp.notFound : tp.loadFailed}
          retryLabel={t.weldpanel.retry}
          onRetry={() => void query.refetch()}
        />
      )}

      {profile && activeTab === 'overview' && <DetailsTab profile={profile} typeName={typeName} />}
      {profile && activeTab === 'members' && <MembersTab profile={profile} projectId={projectId} />}
      {profile && activeTab === 'activity' && <ActivityTab events={profile.recentEvents} />}

      {name && (
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          title={format(tp.deleteTitle, { name })}
          description={tp.deleteDescription}
          confirmLabel={tp.delete}
          cancelLabel={t.weldpanel.analytics.common.cancel}
          variant="destructive"
          loading={remove.isPending}
          onConfirm={handleDelete}
        />
      )}
    </EntityDetailView>
  );
}
