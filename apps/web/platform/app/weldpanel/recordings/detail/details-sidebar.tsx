/**
 * The column on the right of a recording, next to the player: the event
 * timeline (the event at the playhead marked, a click jumps there), the
 * session's info (the page at the playhead, when, how long, device, the
 * person and their other sessions) and its insights (frustration counts, active and idle time, and
 * the moments worth watching). Info also holds the key to the marker colours
 * of the player's timeline, with how many of each the session has.
 */

import { useId, useState, type ComponentType } from 'react';
import {
  AppWindow,
  ArrowDownUp,
  AtSign,
  CalendarClock,
  Clock,
  Cpu,
  FileStack,
  Flame,
  Globe,
  Hourglass,
  Lightbulb,
  ListOrdered,
  LogIn,
  LogOut,
  MapPin,
  Monitor,
  MousePointer2,
  MousePointerClick,
  PauseCircle,
  Smartphone,
  Tablet,
  Timer,
  TriangleAlert,
  Undo2,
  UserRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { PanelPersonDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { RecordingTabPanel, RecordingTabStrip } from '@weldsuite/ui/components/recording-layout';
import { cn } from '@weldsuite/ui/lib/utils';
import { PanelRow, PanelSection } from '@/components/objects/_shared/record-panel-parts';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { countryName, formatDateTime, formatDuration } from '../../lib/format';
import { personDisplayName, visitorLabel } from '../../lib/people';
import { formatClock, pageAt, type MarkerKind, type PageVisit, type TimelineMarker, type TimeRange } from '../../lib/replay';
import { MARKER_STYLES } from '../player/timeline';
import { EventsPanel, markerText } from './side-panels';

type DetailsTab = 'timeline' | 'info' | 'insights';

const MARKER_KINDS: MarkerKind[] = ['page', 'click', 'frustration', 'error', 'custom'];

/** A marker's coloured dot, in the 16px icon slot of a row. */
function markerDot(kind: MarkerKind): ComponentType<{ className?: string }> {
  function MarkerDot({ className }: Readonly<{ className?: string }>) {
    return (
      <span className={cn('flex items-center justify-center', className)} aria-hidden>
        <span className={cn('size-2 rounded-full', MARKER_STYLES[kind])} />
      </span>
    );
  }
  return MarkerDot;
}

const MARKER_DOTS = Object.fromEntries(MARKER_KINDS.map((kind) => [kind, markerDot(kind)])) as Record<MarkerKind, ComponentType<{ className?: string }>>;

const DEVICE_ICONS: Record<NonNullable<PanelSessionRow['deviceType']>, LucideIcon> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

export interface RecordingDetailsSidebarProps {
  projectId: string;
  session: PanelSessionRow;
  person: PanelPersonDto | null;
  otherSessions: readonly PanelSessionRow[];
  /** The replay's own events on the timeline, or the session's when the replay is not loaded. */
  markers: readonly TimelineMarker[];
  /** The pages visited, on the same clock as `markers`. */
  visits: readonly PageVisit[];
  /** Stretches without activity; empty until the replay is loaded. */
  inactive: readonly TimeRange[];
  /** Where the playhead is, in ms from the start. */
  time: number;
  /** Whether the replay is loaded, so idle time is known. */
  replayLoaded: boolean;
  onJump: (ms: number) => void;
}

export function RecordingDetailsSidebar(props: Readonly<RecordingDetailsSidebarProps>) {
  const { t } = useI18n();
  const td = t.weldpanel.observe.session.details;
  const idPrefix = useId();
  const [tab, setTab] = useState<DetailsTab>('timeline');
  const tabs = [
    { id: 'timeline', label: td.tabs.timeline, icon: ListOrdered },
    { id: 'info', label: td.tabs.info, icon: UserRound },
    { id: 'insights', label: td.tabs.insights, icon: Lightbulb },
  ];
  return (
    <>
      {/* 53px, level with the page header beside it. */}
      <RecordingTabStrip tabs={tabs} value={tab} onValueChange={(next) => setTab(next as DetailsTab)} label={td.label} idPrefix={idPrefix} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RecordingTabPanel idPrefix={idPrefix} value="timeline" selected={tab === 'timeline'}>
          <EventsPanel markers={props.markers} currentOffset={props.time} onJump={props.onJump} />
        </RecordingTabPanel>
        <RecordingTabPanel idPrefix={idPrefix} value="info" selected={tab === 'info'}>
          <InfoTab {...props} />
        </RecordingTabPanel>
        <RecordingTabPanel idPrefix={idPrefix} value="insights" selected={tab === 'insights'}>
          <InsightsTab {...props} />
        </RecordingTabPanel>
      </div>
    </>
  );
}

function InfoTab({ projectId, session, person, otherSessions, markers, visits, time }: Readonly<RecordingDetailsSidebarProps>) {
  const { t, language } = useI18n();
  const router = useRouter();
  const ts = t.weldpanel.observe.session;
  const td = ts.details;
  const tm = ts.meta;
  const number = new Intl.NumberFormat(language);
  const name = person ? personDisplayName(person) : visitorLabel(session, t.weldpanel.observe.common.anonymous);
  const device = session.deviceType ? t.weldpanel.observe.common.devices[session.deviceType] : null;
  // The page at the playhead; it follows playback.
  const visit = pageAt(visits, time);

  return (
    <div className="grid gap-6 p-4">
      <PanelSection title={td.session}>
        <div>
          <PanelRow
            icon={AppWindow}
            label={ts.currentPage}
            value={visit ? (visit.url ?? visit.path) : ts.noPage}
            renderValue={(value) => (
              <span className="block truncate font-mono text-xs" title={value ?? undefined}>
                {value}
              </span>
            )}
          />
          <PanelRow icon={CalendarClock} label={td.started} value={formatDateTime(session.startedAt, language)} />
          <PanelRow icon={Timer} label={tm.duration} value={formatDuration(session.durationSeconds)} />
          <PanelRow icon={FileStack} label={tm.pages} value={number.format(session.pageviews)} tabular />
          <PanelRow icon={MousePointerClick} label={tm.clicks} value={number.format(session.clicks)} tabular />
          <PanelRow icon={Zap} label={td.events} value={number.format(session.events)} tabular />
          <PanelRow icon={LogIn} label={td.entryPage} value={session.entryPage} />
          <PanelRow icon={LogOut} label={td.exitPage} value={session.exitPage} />
        </div>
      </PanelSection>

      <PanelSection title={td.device}>
        <div>
          <PanelRow icon={session.deviceType ? DEVICE_ICONS[session.deviceType] : Monitor} label={tm.device} value={device} />
          <PanelRow icon={Globe} label={tm.browser} value={session.browser} />
          <PanelRow icon={Cpu} label={td.os} value={session.os} />
          <PanelRow icon={MapPin} label={tm.country} value={session.country ? countryName(session.country, language) : null} />
        </div>
      </PanelSection>

      <PanelSection title={td.person}>
        <div>
          <PanelRow icon={UserRound} label={td.name} value={name} />
          {person?.email && <PanelRow icon={AtSign} label={td.email} value={person.email} />}
        </div>
        {!person && <p className="text-sm text-muted-foreground">{ts.person.noProfile}</p>}
      </PanelSection>

      <PanelSection title={ts.person.otherSessions}>
        {otherSessions.length === 0 ? (
          <EmptyText>{ts.person.noOtherSessions}</EmptyText>
        ) : (
          <div className="-mx-4 border-t border-gray-200/70 dark:border-border">
            <TabListScope>
              {otherSessions.map((other) => {
                const started = formatDateTime(other.startedAt, language);
                return (
                  <TabListRow
                    key={other.sessionId}
                    label={started}
                    onOpen={() => router.push(`/weldpanel/recordings/${encodeURIComponent(other.sessionId)}?project=${encodeURIComponent(projectId)}`)}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{started}</span>
                    <span className="w-[64px] shrink-0 text-right text-sm text-muted-foreground">{formatDuration(other.durationSeconds)}</span>
                  </TabListRow>
                );
              })}
            </TabListScope>
          </div>
        )}
      </PanelSection>

      <PanelSection title={td.colours}>
        <div>
          {MARKER_KINDS.map((kind) => (
            <PanelRow
              key={kind}
              icon={MARKER_DOTS[kind]}
              label={t.weldpanel.observe.player.legend[kind]}
              value={number.format(markers.filter((marker) => marker.kind === kind).length)}
              tabular
            />
          ))}
        </div>
      </PanelSection>
    </div>
  );
}

function InsightsTab({ session, markers, inactive, replayLoaded, onJump }: Readonly<RecordingDetailsSidebarProps>) {
  const { t, format, language } = useI18n();
  const ts = t.weldpanel.observe.session;
  const td = ts.details;
  const signals = t.weldpanel.observe.recordings.signals;
  const number = new Intl.NumberFormat(language);
  const idleSeconds = inactive.reduce((sum, range) => sum + (range.endMs - range.startMs), 0) / 1000;
  const activeSeconds = Math.max(0, session.durationSeconds - idleSeconds);
  const moments = markers.filter((marker) => marker.kind === 'frustration' || marker.kind === 'error');

  const counts: { icon: LucideIcon; label: string; count: number }[] = [
    { icon: Flame, label: signals.rage, count: session.rageClicks },
    { icon: MousePointer2, label: signals.dead, count: session.deadClicks },
    { icon: Undo2, label: signals.quickback, count: session.quickBacks },
    { icon: ArrowDownUp, label: td.scrolling, count: session.excessiveScrolls },
    { icon: TriangleAlert, label: signals.errors, count: session.errors },
  ];

  return (
    <div className="grid gap-6 p-4">
      <PanelSection title={td.frustration}>
        <div>
          {counts.map(({ icon, label, count }) => (
            <PanelRow
              key={label}
              icon={icon}
              label={label}
              value={number.format(count)}
              tabular
              renderValue={(value) => <span className={cn(count > 0 && 'font-medium text-orange-600 dark:text-orange-400')}>{value}</span>}
            />
          ))}
        </div>
      </PanelSection>

      <PanelSection title={td.engagement}>
        <div>
          <PanelRow icon={Clock} label={td.activeTime} value={replayLoaded ? formatDuration(activeSeconds) : null} />
          <PanelRow icon={PauseCircle} label={td.idleTime} value={replayLoaded ? formatDuration(idleSeconds) : null} />
          <PanelRow
            icon={Hourglass}
            label={td.timePerPage}
            value={session.pageviews > 0 ? formatDuration(session.durationSeconds / session.pageviews) : null}
          />
        </div>
      </PanelSection>

      <PanelSection title={td.moments}>
        {moments.length === 0 ? (
          <EmptyText>{td.noMoments}</EmptyText>
        ) : (
          <div className="-mx-4 border-t border-gray-200/70 dark:border-border">
            <TabListScope>
              {moments.map((marker) => (
                <TabListRow
                  key={marker.id}
                  label={`${ts.events.kinds[marker.kind]}: ${markerText(marker)}. ${format(ts.events.jump, { time: formatClock(marker.offsetMs) })}`}
                  onOpen={() => onJump(Math.max(0, marker.offsetMs - 1500))}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className={cn('size-2 shrink-0 rounded-full', MARKER_STYLES[marker.kind])} aria-hidden />
                    <span className="truncate text-sm" title={markerText(marker)}>
                      {markerText(marker)}
                    </span>
                  </div>
                  <span className="w-[44px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatClock(marker.offsetMs)}</span>
                </TabListRow>
              ))}
            </TabListScope>
          </div>
        )}
      </PanelSection>
    </div>
  );
}
