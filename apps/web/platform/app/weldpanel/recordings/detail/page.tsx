/**
 * One recording, in the shared recording page shell (`recording-layout`) that
 * WeldMeet meetings and WeldCRM calls use too, so they always look alike: the
 * header bar, the player with its timeline, tabs under it for the AI summary
 * and the pages visited, and a details column on the right (the event
 * timeline, the session's info, its insights). A favourite's note shows above
 * the player; favourites are set from the Recordings list.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useParams } from '@tanstack/react-router';
import { FileStack, ScrollText } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { RecordingHeader, RecordingLayout, RecordingTabPanel, RecordingTabStrip } from '@weldsuite/ui/components/recording-layout';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useWeldPanelSession } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import { isNotFoundError } from '../../lib/api-errors';
import { personDisplayName, visitorLabel } from '../../lib/people';
import { buildMarkers, buildPageVisits, inactiveRanges, type PageVisit, type ReplayEvent, type TimelineMarker, type TimeRange } from '../../lib/replay';
import { useCurrentProject } from '../../lib/use-current-project';
import { useProjectParam } from '../../lib/use-project-param';
import { ReplayPlayer, type ReplayPlayerHandle } from '../player/replay-player';
import { useSessionReplay, type ReplayLoadState } from '../player/use-session-replay';
import { SummaryPanel } from '../summary-panel';
import { RecordingDetailsSidebar } from './details-sidebar';
import { PagesPanel } from './side-panels';

type SessionData = NonNullable<ReturnType<typeof useWeldPanelSession>['data']>;

function sessionName(data: SessionData, session: SessionData['session'], anonymous: string): string {
  return data.person ? personDisplayName(data.person) : visitorLabel(session, anonymous);
}

function replayErrorMessage(reason: 'gone' | 'failed' | 'no-snapshot', ts: { expired: string; noSnapshot: string; playbackFailed: string }): string {
  if (reason === 'gone') return ts.expired;
  if (reason === 'no-snapshot') return ts.noSnapshot;
  return ts.playbackFailed;
}

interface ReplayStageProps {
  replay: ReplayLoadState;
  noRecording: boolean;
  events: ReplayEvent[] | null;
  playerFailed: boolean;
  markers: readonly TimelineMarker[];
  inactive: readonly TimeRange[];
  playerRef: RefObject<ReplayPlayerHandle | null>;
  onTimeChange: (ms: number) => void;
  onError: () => void;
}

function ReplayStage({ replay, noRecording, events, playerFailed, markers, inactive, playerRef, onTimeChange, onError }: Readonly<ReplayStageProps>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.observe.session;
  const progress = replay.status === 'loading' ? replay : null;
  return (
    // The player runs edge to edge, with no padding; the notes and states around it keep 16px.
    <div className="min-w-0">
      {noRecording && (
        <div className="p-4">
          <InfoBanner variant="neutral">{ts.noPlayback}</InfoBanner>
        </div>
      )}
      {progress && (
        <div className="grid gap-3 p-4" role="status">
          <Skeleton className="h-[min(62vh,640px)] min-h-60 w-full" />
          <p className="text-sm text-muted-foreground">{format(ts.loadingProgress, { done: progress.done, total: progress.total })}</p>
        </div>
      )}
      {replay.status === 'error' && (
        <div className="p-4">
          <ErrorState
            message={replayErrorMessage(replay.reason, ts)}
            onRetry={replay.reason === 'failed' ? () => window.location.reload() : undefined}
            retryLabel={t.weldpanel.retry}
          />
        </div>
      )}
      {events && playerFailed && (
        <div className="p-4">
          <ErrorState message={ts.playbackFailed} />
        </div>
      )}
      {events && !playerFailed && (
        <ReplayPlayer ref={playerRef} events={events} markers={markers} inactive={inactive} onTimeChange={onTimeChange} onError={onError} />
      )}
    </div>
  );
}

interface RecordingTabsProps {
  projectId: string;
  sessionId: string;
  aiEnabled: boolean;
  data: SessionData;
  session: SessionData['session'];
  visits: readonly PageVisit[];
  time: number;
  onJump: (ms: number) => void;
}

type RecordingTabId = 'summary' | 'pages';

function RecordingTabs({ projectId, sessionId, aiEnabled, data, session, visits, time, onJump }: Readonly<RecordingTabsProps>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.observe.session;
  const idPrefix = useId();
  const [tab, setTab] = useState<RecordingTabId>('summary');
  const tabs = [
    { id: 'summary', label: ts.tabs.summary, icon: ScrollText },
    { id: 'pages', label: ts.tabs.pages, icon: FileStack },
  ];
  return (
    <div className="pb-4">
      <RecordingTabStrip
        tabs={tabs}
        value={tab}
        onValueChange={(next) => setTab(next as RecordingTabId)}
        label={format(ts.title, { name: sessionName(data, session, t.weldpanel.observe.common.anonymous) })}
        idPrefix={idPrefix}
        separated
      />
      <RecordingTabPanel idPrefix={idPrefix} value="summary" selected={tab === 'summary'}>
        <div className="px-4 pt-4">
          <SummaryPanel projectId={projectId} sessionId={sessionId} aiEnabled={aiEnabled} />
        </div>
      </RecordingTabPanel>
      <RecordingTabPanel idPrefix={idPrefix} value="pages" selected={tab === 'pages'}>
        {/* A standard list: edge to edge, its toolbar right under the tabs. */}
        <PagesPanel visits={visits} currentOffset={time} onJump={onJump} />
      </RecordingTabPanel>
    </div>
  );
}

export default function RecordingDetailPage() {
  const { sessionId = '' } = useParams({ strict: false });
  const search = useSearchParams();
  useProjectParam(search.get('project') ?? undefined);
  const { project, isLoading, isError, refetch } = useCurrentProject();
  const { t } = useI18n();

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;
  if (isError) return <ErrorState message={t.weldpanel.analytics.projectBar.loadFailed} onRetry={refetch} retryLabel={t.weldpanel.retry} />;
  if (!project) return <EmptyState title={t.weldpanel.analytics.needProject.title} description={t.weldpanel.analytics.needProject.description} />;
  return <RecordingView key={`${project.id}:${sessionId}`} projectId={project.id} aiEnabled={project.settings.aiEnabled} sessionId={sessionId} />;
}

function RecordingView({ projectId, aiEnabled, sessionId }: Readonly<{ projectId: string; aiEnabled: boolean; sessionId: string }>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.observe.session;
  const router = useRouter();
  const { data, isLoading, error, refetch } = useWeldPanelSession(projectId, sessionId);
  const replay = useSessionReplay(projectId, sessionId, data?.chunks);
  const playerRef = useRef<ReplayPlayerHandle>(null);
  const [time, setTime] = useState(0);
  const [playerFailed, setPlayerFailed] = useState(false);

  const session = data?.session;
  const name = data && session ? sessionName(data, session, t.weldpanel.observe.common.anonymous) : '';

  useBreadcrumbs(
    [
      { label: t.weldpanel.breadcrumb.home, href: '/weldpanel' },
      { label: t.navigation.moduleSidebar.weldpanel.recordings, href: '/weldpanel/recordings' },
      { label: name || '…' },
    ],
    { enabled: !!session },
  );

  const events = replay.status === 'ready' ? replay.events : null;
  const replayStart = events?.[0]?.timestamp ?? 0;
  const replayLength = events ? events[events.length - 1]!.timestamp - replayStart : 0;
  // Without a loaded replay the lists fall back to the session's own start and length.
  const markers = useMemo(() => {
    if (!data) return [];
    if (events) return buildMarkers(data.events, replayStart, replayLength);
    return buildMarkers(data.events, Date.parse(data.session.startedAt), data.session.durationSeconds * 1000);
  }, [data, events, replayStart, replayLength]);
  const visits = useMemo(() => {
    if (!data) return [];
    if (events) return buildPageVisits(data.events, replayStart, replayLength);
    return buildPageVisits(data.events, Date.parse(data.session.startedAt), data.session.durationSeconds * 1000);
  }, [data, events, replayStart, replayLength]);
  const inactive = useMemo(() => (events ? inactiveRanges(events, replayStart) : []), [events, replayStart]);
  const jump = useCallback((ms: number) => playerRef.current?.seek(ms), []);
  const onError = useCallback(() => setPlayerFailed(true), []);

  useEffect(() => {
    setPlayerFailed(false);
  }, [events]);

  if (isLoading) return <PageLoader fullScreen={false} label={t.common.labels.loading} />;

  if (error || !data || !session) {
    const missing = isNotFoundError(error);
    return (
      <div className="mx-auto max-w-2xl p-6">
        <ErrorState message={missing ? ts.notFound : ts.loadFailed} onRetry={missing ? undefined : () => void refetch()} retryLabel={t.weldpanel.retry} />
        <Button variant="outline" size="sm" className="mt-3" onClick={() => router.push('/weldpanel/recordings')}>
          {ts.back}
        </Button>
      </div>
    );
  }

  const noRecording = data.chunks.length === 0;

  return (
    <RecordingLayout
      header={
        <RecordingHeader
          onBack={() => (window.history.length > 1 ? router.back() : router.push('/weldpanel/recordings'))}
          backLabel={ts.back}
          title={format(ts.title, { name })}
        />
      }
      sidebar={
        <RecordingDetailsSidebar
          projectId={projectId}
          session={session}
          person={data.person}
          otherSessions={data.otherSessions}
          markers={markers}
          visits={visits}
          inactive={inactive}
          time={time}
          replayLoaded={!!events}
          onJump={jump}
        />
      }
    >
      {data.favorite?.note && (
        <div className="px-4 pt-4">
          <InfoBanner variant="tip" title={ts.favorite.noteLabel}>
            {data.favorite.note}
          </InfoBanner>
        </div>
      )}
      <ReplayStage replay={replay} noRecording={noRecording} events={events} playerFailed={playerFailed} markers={markers} inactive={inactive} playerRef={playerRef} onTimeChange={setTime} onError={onError} />
      <RecordingTabs projectId={projectId} sessionId={sessionId} aiEnabled={aiEnabled} data={data} session={session} visits={visits} time={time} onJump={jump} />
    </RecordingLayout>
  );
}
