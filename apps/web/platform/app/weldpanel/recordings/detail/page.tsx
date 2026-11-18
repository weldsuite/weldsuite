/**
 * One recording: the player with its timeline, and beside it the AI summary,
 * the pages visited, the events and the person with their other sessions.
 * Favourites (with a note) are kept longer than other recordings.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useParams } from '@tanstack/react-router';
import { Star } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Label } from '@weldsuite/ui/components/label';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useFavoriteWeldPanelSession, useUnfavoriteWeldPanelSession, useWeldPanelSession } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter, useSearchParams } from '@/lib/router';
import { isNotFoundError } from '../../lib/api-errors';
import { formatDateTime } from '../../lib/format';
import { personDisplayName, visitorLabel } from '../../lib/people';
import { buildMarkers, buildPageVisits, inactiveRanges, type PageVisit, type ReplayEvent, type TimelineMarker, type TimeRange } from '../../lib/replay';
import { useCurrentProject } from '../../lib/use-current-project';
import { useProjectParam } from '../../lib/use-project-param';
import { ReplayPlayer, type ReplayPlayerHandle } from '../player/replay-player';
import { useSessionReplay, type ReplayLoadState } from '../player/use-session-replay';
import { SummaryPanel } from '../summary-panel';
import { EventsPanel, PagesPanel, PersonPanel } from './side-panels';

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
  visits: readonly PageVisit[];
  playerRef: RefObject<ReplayPlayerHandle | null>;
  onTimeChange: (ms: number) => void;
  onError: () => void;
}

function ReplayStage({ replay, noRecording, events, playerFailed, markers, inactive, visits, playerRef, onTimeChange, onError }: Readonly<ReplayStageProps>) {
  const { t, format } = useI18n();
  const ts = t.weldpanel.observe.session;
  const progress = replay.status === 'loading' ? replay : null;
  return (
    <div className="min-w-0">
      {noRecording && <InfoBanner variant="neutral">{ts.noPlayback}</InfoBanner>}
      {progress && (
        <div className="grid gap-3" role="status">
          <Skeleton className="h-[min(62vh,640px)] min-h-60 w-full" />
          <p className="text-sm text-muted-foreground">{format(ts.loadingProgress, { done: progress.done, total: progress.total })}</p>
        </div>
      )}
      {replay.status === 'error' && (
        <ErrorState
          message={replayErrorMessage(replay.reason, ts)}
          onRetry={replay.reason === 'failed' ? () => window.location.reload() : undefined}
          retryLabel={t.weldpanel.retry}
        />
      )}
      {events && playerFailed && <ErrorState message={ts.playbackFailed} />}
      {events && !playerFailed && (
        <ReplayPlayer ref={playerRef} events={events} markers={markers} inactive={inactive} visits={visits} onTimeChange={onTimeChange} onError={onError} />
      )}
    </div>
  );
}

interface SidePanelsProps {
  projectId: string;
  sessionId: string;
  aiEnabled: boolean;
  data: SessionData;
  session: SessionData['session'];
  markers: readonly TimelineMarker[];
  visits: readonly PageVisit[];
  time: number;
  canSeePeople: boolean;
  onJump: (ms: number) => void;
}

function SidePanels({ projectId, sessionId, aiEnabled, data, session, markers, visits, time, canSeePeople, onJump }: Readonly<SidePanelsProps>) {
  const { t } = useI18n();
  const ts = t.weldpanel.observe.session;
  // Without a loaded replay the panels fall back to the session's own start and length.
  const startMs = Date.parse(session.startedAt);
  const durationMs = session.durationSeconds * 1000;
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4">
      <Tabs defaultValue="summary" className="gap-4">
        <TabsList className="h-auto w-full flex-wrap justify-start">
          <TabsTrigger value="summary">{ts.tabs.summary}</TabsTrigger>
          <TabsTrigger value="pages">{ts.tabs.pages}</TabsTrigger>
          <TabsTrigger value="events">{ts.tabs.events}</TabsTrigger>
          <TabsTrigger value="person">{ts.tabs.person}</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">
          <SummaryPanel projectId={projectId} sessionId={sessionId} aiEnabled={aiEnabled} />
        </TabsContent>
        <TabsContent value="pages">
          <PagesPanel visits={visits.length > 0 ? visits : buildPageVisits(data.events, startMs, durationMs)} currentOffset={time} onJump={onJump} />
        </TabsContent>
        <TabsContent value="events">
          <EventsPanel
            markers={markers.length > 0 ? markers : buildMarkers(data.events, startMs, durationMs)}
            onJump={onJump}
          />
        </TabsContent>
        <TabsContent value="person">
          <PersonPanel projectId={projectId} current={session} person={data.person} otherSessions={data.otherSessions} canSeePeople={canSeePeople} />
        </TabsContent>
      </Tabs>
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
  const { t, language, format } = useI18n();
  const ts = t.weldpanel.observe.session;
  const router = useRouter();
  const canSeePeople = useCan('panel_people:read');
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
  const markers = useMemo(() => (data && events ? buildMarkers(data.events, replayStart, replayLength) : []), [data, events, replayStart, replayLength]);
  const visits = useMemo(() => (data && events ? buildPageVisits(data.events, replayStart, replayLength) : []), [data, events, replayStart, replayLength]);
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
    <DetailPage className="mx-auto w-full max-w-[1500px]">
      <div className="space-y-4 p-4 sm:p-6">
        <DetailHeader
          onBack={() => (window.history.length > 1 ? router.back() : router.push('/weldpanel/recordings'))}
          backLabel={ts.back}
          title={format(ts.title, { name })}
          subtitle={format(ts.startedAt, { date: formatDateTime(session.startedAt, language) })}
          actions={<FavoriteControl projectId={projectId} sessionId={sessionId} favorite={data.favorite} />}
        />
        {data.favorite?.note && (
          <InfoBanner variant="tip" title={ts.favorite.noteLabel}>
            {data.favorite.note}
          </InfoBanner>
        )}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <ReplayStage replay={replay} noRecording={noRecording} events={events} playerFailed={playerFailed} markers={markers} inactive={inactive} visits={visits} playerRef={playerRef} onTimeChange={setTime} onError={onError} />

          <SidePanels projectId={projectId} sessionId={sessionId} aiEnabled={aiEnabled} data={data} session={session} markers={markers} visits={visits} time={time} canSeePeople={canSeePeople} onJump={jump} />
        </div>
      </div>
    </DetailPage>
  );
}

function FavoriteControl({ projectId, sessionId, favorite }: Readonly<{ projectId: string; sessionId: string; favorite: { note: string | null } | null }>) {
  const { t } = useI18n();
  const tf = t.weldpanel.observe.session.favorite;
  const add = useFavoriteWeldPanelSession(projectId);
  const remove = useUnfavoriteWeldPanelSession(projectId);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  function save() {
    add.mutate(
      { sessionId, note: note.trim() === '' ? null : note.trim() },
      {
        onSuccess: () => {
          toast.success(tf.added);
          setOpen(false);
        },
        onError: () => toast.error(tf.failed),
      },
    );
  }

  if (favorite) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={remove.isPending}
        onClick={() => remove.mutate(sessionId, { onSuccess: () => toast.success(tf.removed), onError: () => toast.error(tf.failed) })}
      >
        <Star className="fill-amber-400 text-amber-500" />
        {tf.remove}
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setNote('');
          setOpen(true);
        }}
      >
        <Star />
        {tf.add}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tf.dialogTitle}</DialogTitle>
            <DialogDescription>{tf.dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="weldpanel-favorite-note">{tf.note}</Label>
            <Textarea id="weldpanel-favorite-note" value={note} maxLength={2000} placeholder={tf.notePlaceholder} onChange={(event) => setNote(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tf.cancel}
            </Button>
            <Button type="button" disabled={add.isPending} onClick={save}>
              {tf.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
