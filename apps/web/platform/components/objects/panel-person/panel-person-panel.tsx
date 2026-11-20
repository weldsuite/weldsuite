/**
 * WeldPanel person object panel: the record view of someone a project has
 * seen, built like the other record panels (the WeldHR employee, the WeldCRM
 * company): the `EntityDetailView` shell from `useObjectPanelShell` (side
 * panel ↔ fullscreen, previous / next, back arrow), an avatar + name header
 * with the WeldCRM link and the "⋮" menu, the icon tab strip, and tabs of
 * property rows and standard list rows.
 *
 * It replaces the standalone `/weldpanel/users/:distinctId` page, which now
 * redirects to the Users list with this panel open in fullscreen.
 *
 * Tabs: Details (when first and last seen, events, ids, every property) ·
 * Activity (recent events) · Recordings (the person's sessions).
 */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AtSign,
  CalendarClock,
  CalendarPlus,
  EllipsisVertical,
  Fingerprint,
  Hash,
  SquareArrowOutUpRight,
  Tag,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useCan } from '@weldsuite/permissions/react';
import type { PanelActivityEvent, PanelPersonProfile } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  ObjectPanelTabs,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
} from '@/components/object-panel';
import { EntityList, type HeaderColumn } from '@/components/entity-list';
import { PanelRow, PanelSection, RecordLoadFailed } from '@/components/objects/_shared/record-panel-parts';
import { ActivityIllustration, TAB_EMPTY_STATE_TABLE_CLASS, tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { usePersonSearch } from '@/components/objects/person/use-person-data';
import { useAppAccess } from '@/hooks/use-app-access';
import { useEraseWeldPanelPerson, useWeldPanelPerson } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { TypedConfirmDialog } from '@/app/weldpanel/components/typed-confirm-dialog';
import { SignalBadges } from '@/app/weldpanel/recordings/signal-badges';
import { isNotFoundError } from '@/app/weldpanel/lib/api-errors';
import { formatDateTime, formatDuration, formatNumber } from '@/app/weldpanel/lib/format';
import { personRecordingsHref } from '@/app/weldpanel/lib/observe-links';
import { personDisplayName, propertyText } from '@/app/weldpanel/lib/people';
import { useCurrentProject } from '@/app/weldpanel/lib/use-current-project';
import { PANEL_PERSON_TAB_ICONS, isPanelPersonTabId, parsePanelPersonId, type PanelPersonTabId } from './panel-person-tabs';

const PANEL_PERSON_WIDTH = 400;

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? (words.at(-1)?.[0] ?? '') : '')).toUpperCase() || '#';
}

/** The WeldCRM person with this email, if WeldCRM is installed and one exists. */
function useCrmPerson(email: string | null) {
  const { isInstalled } = useAppAccess('weldcrm');
  const address = email?.trim().toLowerCase() ?? '';
  const { data } = usePersonSearch(address, isInstalled && address !== '');
  return useMemo(() => (isInstalled ? (data?.data.find((p) => p.email?.toLowerCase() === address) ?? null) : null), [data, address, isInstalled]);
}

// ─── Header ────────────────────────────────────────────────────────────────

function PersonPanelAvatar({ name }: Readonly<{ name?: string }>) {
  if (!name) return <div className="size-[22px] animate-pulse rounded-[32%] bg-muted" />;
  return (
    <Avatar className="size-[22px]">
      <AvatarFallback className="bg-muted text-[10px] font-medium">{initials(name)}</AvatarFallback>
    </Avatar>
  );
}

function PersonPanelTitle({ name }: Readonly<{ name?: string }>) {
  if (!name) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />;
  return <span className="block truncate text-[15px] font-medium leading-6 text-foreground">{name}</span>;
}

/** The header actions: the matching WeldCRM person, and the "⋮" menu with Erase. */
function PersonPanelActions({
  crmPersonId,
  canErase,
  onErase,
}: Readonly<{ crmPersonId: string | null; canErase: boolean; onErase: () => void }>) {
  const { t } = useI18n();
  const st = useTranslations();
  const router = useRouter();
  const tp = t.weldpanel.observe.person;
  // Same 28px icon buttons as the shell's Expand / Close.
  return (
    <>
      {crmPersonId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7"
              onClick={() => router.push(`/weldcrm/people/${encodeURIComponent(crmPersonId)}`)}
              aria-label={tp.openInCrm}
            >
              <SquareArrowOutUpRight className="size-4 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tp.openInCrm}</TooltipContent>
        </Tooltip>
      )}
      {canErase && (
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
            <DropdownMenuItem variant="destructive" onClick={onErase}>
              <Trash2 />
              {tp.erase.button}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

// ─── Tabs ──────────────────────────────────────────────────────────────────

function DetailsTab({ profile }: Readonly<{ profile: PanelPersonProfile }>) {
  const { t, language } = useI18n();
  const tp = t.weldpanel.observe.person;
  const { person } = profile;
  const properties = Object.entries(person.properties);
  return (
    <div className="space-y-5 p-4">
      <div className="space-y-1">
        <PanelRow icon={AtSign} label={t.weldpanel.observe.users.columns.email} value={person.email} />
        <PanelRow icon={CalendarPlus} label={tp.firstSeen} value={formatDateTime(person.firstSeen, language)} />
        <PanelRow icon={CalendarClock} label={tp.lastSeen} value={formatDateTime(person.lastSeen, language)} />
        <PanelRow icon={Hash} label={tp.events90d} value={formatNumber(profile.eventCount90d, language)} tabular />
        <PanelRow icon={UserRound} label={tp.userId} value={person.userId} />
        <PanelRow icon={Fingerprint} label={tp.anonIds} value={person.anonIds.length === 0 ? tp.noAnonIds : person.anonIds.join(', ')} />
      </div>
      <PanelSection title={tp.properties}>
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

type EventRow = PanelActivityEvent & { id: string };

const EVENT_COLUMN = {
  name: 'min-w-0 flex-1',
  page: 'w-[200px] @max-[560px]:hidden',
  time: 'w-[150px] @max-[560px]:w-[120px]',
};

function ActivityTab({ events }: Readonly<{ events: PanelActivityEvent[] }>) {
  const { t, language } = useI18n();
  const tp = t.weldpanel.observe.person;
  const items = useMemo<EventRow[]>(() => events.map((event) => ({ ...event, id: event.eventId })), [events]);
  const headerColumns: HeaderColumn[] = [
    { id: 'name', header: tp.tabs.activity, width: EVENT_COLUMN.name },
    { id: 'page', header: t.weldpanel.observe.recordings.columns.pages, width: EVENT_COLUMN.page },
    { id: 'time', header: t.weldpanel.observe.recordings.columns.started, width: EVENT_COLUMN.time },
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
            <div className={`${EVENT_COLUMN.page} truncate text-sm text-muted-foreground`}>{[event.path, event.detail].filter(Boolean).join(' · ') || '—'}</div>
            <div className={`${EVENT_COLUMN.time} whitespace-nowrap text-sm tabular-nums text-muted-foreground`}>{formatDateTime(event.ts, language)}</div>
          </TabListRow>
        )}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <ActivityIllustration />, title: tp.activity, description: tp.noActivity }}
      />
    </TabListScope>
  );
}

type SessionRow = PanelSessionRow & { id: string };

const SESSION_COLUMN = {
  started: 'min-w-0 flex-1',
  duration: 'w-[90px]',
  pages: 'w-[70px] @max-[560px]:hidden',
  signals: 'w-[160px] @max-[560px]:hidden',
};

function RecordingsTab({ profile, projectId, canWatch }: Readonly<{ profile: PanelPersonProfile; projectId: string; canWatch: boolean }>) {
  const { t, language } = useI18n();
  const tp = t.weldpanel.observe.person;
  const tr = t.weldpanel.observe.recordings.columns;
  const router = useRouter();
  const items = useMemo<SessionRow[]>(() => profile.sessions.map((session) => ({ ...session, id: session.sessionId })), [profile.sessions]);
  const headerColumns: HeaderColumn[] = [
    { id: 'started', header: tr.started, width: SESSION_COLUMN.started },
    { id: 'duration', header: tr.duration, width: SESSION_COLUMN.duration },
    { id: 'pages', header: tr.pages, width: SESSION_COLUMN.pages },
    { id: 'signals', header: tr.signals, width: SESSION_COLUMN.signals },
  ];
  const watch = (session: SessionRow) =>
    router.push(`/weldpanel/recordings/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(projectId)}`);
  return (
    <TabListScope>
      <EntityList<SessionRow>
        items={items}
        isLoading={false}
        error={null}
        filters={[]}
        hideFilter
        headerColumns={headerColumns}
        actionButtons={
          canWatch ? (
            <Button variant="outline" size="sm" className="h-8" onClick={() => router.push(personRecordingsHref(profile.person.userId, projectId))}>
              {tp.allRecordings}
            </Button>
          ) : undefined
        }
        renderRow={(session) => (
          <TabListRow key={session.id} label={tp.watch} onOpen={canWatch && session.hasRecording ? () => watch(session) : undefined}>
            <div className={`${SESSION_COLUMN.started} truncate text-sm font-medium text-foreground`}>{formatDateTime(session.startedAt, language)}</div>
            <div className={`${SESSION_COLUMN.duration} text-sm tabular-nums text-muted-foreground`}>{formatDuration(session.durationSeconds)}</div>
            <div className={`${SESSION_COLUMN.pages} text-sm tabular-nums text-muted-foreground`}>{session.pageviews}</div>
            <div className={`${SESSION_COLUMN.signals} min-w-0`}>
              <SignalBadges session={session} />
            </div>
          </TabListRow>
        )}
        emptyStateClassName={TAB_EMPTY_STATE_TABLE_CLASS}
        emptyState={{ icon: <ActivityIllustration />, title: tp.recordings, description: tp.noRecordings }}
      />
    </TabListScope>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function PanelPersonPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { t, format } = useI18n();
  const st = useTranslations();
  const { id, onClose, initialTab } = props;
  const tp = t.weldpanel.observe.person;
  const parsed = parsePanelPersonId(id);
  const { project } = useCurrentProject();
  // A link without a project shows the person in the project picked in the sidebar.
  const projectId = parsed.projectId || project?.id || '';
  const { distinctId } = parsed;

  const canErase = useCan('panel_people:delete');
  const canWatch = useCan('panel_recordings:read');
  const query = useWeldPanelPerson(projectId, distinctId);
  const profile = query.data;
  const erase = useEraseWeldPanelPerson(projectId);
  const crmPerson = useCrmPerson(profile?.person.email ?? null);
  const name = profile ? personDisplayName(profile.person) : undefined;

  const shell = useObjectPanelShell({ ...props, width: PANEL_PERSON_WIDTH, loading: query.isLoading && !profile });
  const mode = shell.mode;

  const [activeTab, setActiveTab] = useState<PanelPersonTabId>(() => (isPanelPersonTabId(initialTab) ? initialTab : 'overview'));
  const [confirmErase, setConfirmErase] = useState(false);

  const tabs = useMemo(
    () =>
      (['overview', 'activity', 'recordings'] as const).map((tabId) => ({
        id: tabId,
        label: tabId === 'overview' ? st('sweep.entities.detailsTab') : tp.tabs[tabId],
        icon: PANEL_PERSON_TAB_ICONS[tabId],
        count: tabId === 'recordings' && profile && profile.sessions.length > 0 ? profile.sessions.length : undefined,
      })),
    [st, tp.tabs, profile],
  );

  async function handleErase() {
    try {
      const result = await erase.mutateAsync(distinctId);
      toast.success(format(tp.erase.done, { ids: result.erasedIdCount, chunks: result.recordingChunksDeleted }));
      setConfirmErase(false);
      onClose();
    } catch {
      toast.error(tp.erase.failed);
    }
  }

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(mode)}
      avatar={<PersonPanelAvatar name={name} />}
      title={<PersonPanelTitle name={name} />}
      actions={profile ? <PersonPanelActions crmPersonId={crmPerson?.id ?? null} canErase={canErase} onErase={() => setConfirmErase(true)} /> : null}
      tabs={<ObjectPanelTabs tabs={tabs} activeTab={activeTab} onChange={(tabId) => setActiveTab(tabId as PanelPersonTabId)} />}
    >
      {!profile && query.isError && (
        <RecordLoadFailed
          notFound={isNotFoundError(query.error)}
          message={isNotFoundError(query.error) ? tp.notFound : tp.loadFailed}
          retryLabel={t.weldpanel.retry}
          onRetry={() => void query.refetch()}
        />
      )}

      {profile && activeTab === 'overview' && <DetailsTab profile={profile} />}
      {profile && activeTab === 'activity' && <ActivityTab events={profile.recentEvents} />}
      {profile && activeTab === 'recordings' && <RecordingsTab profile={profile} projectId={projectId} canWatch={canWatch} />}

      {name && (
        <TypedConfirmDialog
          open={confirmErase}
          onOpenChange={setConfirmErase}
          title={format(tp.erase.title, { name })}
          description={tp.erase.description}
          expected={name}
          prompt={format(tp.erase.prompt, { name })}
          confirmLabel={tp.erase.confirm}
          cancelLabel={tp.erase.cancel}
          onConfirm={handleErase}
        />
      )}
    </EntityDetailView>
  );
}
