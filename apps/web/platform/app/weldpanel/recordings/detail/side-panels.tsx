/** The tabs beside the player: the page list, the event list and the person with their other sessions. */

import { useState } from 'react';
import { cn } from '@weldsuite/ui/lib/utils';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import type { PanelPersonDto } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import type { PanelSessionRow } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { countryName, formatDateTime, formatDuration } from '../../lib/format';
import { personDisplayName, visitorLabel } from '../../lib/people';
import { formatClock, type PageVisit, type TimelineMarker } from '../../lib/replay';
import { MARKER_STYLES } from '../player/timeline';
import { SignalBadges } from '../signal-badges';

function markerText(marker: TimelineMarker): string {
  if (marker.kind === 'page' || marker.kind === 'click') return marker.label;
  return marker.name === marker.label ? marker.name : `${marker.name}: ${marker.label}`;
}

export function PagesPanel({ visits, currentOffset, onJump }: Readonly<{ visits: readonly PageVisit[]; currentOffset: number; onJump: (ms: number) => void }>) {
  const { t, format } = useI18n();
  const tp = t.weldpanel.observe.session.pages;
  if (visits.length === 0) return <EmptyText>{tp.empty}</EmptyText>;
  let activeIndex = 0;
  visits.forEach((visit, index) => {
    if (visit.offsetMs <= currentOffset) activeIndex = index;
  });
  return (
    <ol className="grid gap-1">
      {visits.map((visit, index) => (
        <li key={`${visit.offsetMs}-${visit.path}`}>
          <button
            type="button"
            aria-label={format(tp.jump, { path: visit.path })}
            aria-current={index === activeIndex ? 'true' : undefined}
            onClick={() => onJump(visit.offsetMs)}
            className={cn('flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-accent', index === activeIndex && 'bg-accent')}
          >
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-[11px] font-semibold text-sky-700 dark:text-sky-300">{index + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{visit.path}</span>
              {visit.title && <span className="block truncate text-xs text-muted-foreground">{visit.title}</span>}
              <span className="block text-xs text-muted-foreground">{format(tp.stayed, { duration: formatDuration(visit.durationMs / 1000) })}</span>
            </span>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatClock(visit.offsetMs)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

type EventFilter = 'all' | 'frustration' | 'error';

export function EventsPanel({ markers, onJump }: Readonly<{ markers: readonly TimelineMarker[]; onJump: (ms: number) => void }>) {
  const { t, format } = useI18n();
  const te = t.weldpanel.observe.session.events;
  const [filter, setFilter] = useState<EventFilter>('all');
  const shown = markers.filter((m) => filter === 'all' || m.kind === filter);
  return (
    <div className="grid gap-3">
      <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(value) => value && setFilter(value as EventFilter)} aria-label={te.title}>
        <ToggleGroupItem value="all">{te.filterAll}</ToggleGroupItem>
        <ToggleGroupItem value="frustration">{te.filterFrustration}</ToggleGroupItem>
        <ToggleGroupItem value="error">{te.filterErrors}</ToggleGroupItem>
      </ToggleGroup>
      {shown.length === 0 ? (
        <EmptyText>{filter === 'error' ? te.noErrors : te.empty}</EmptyText>
      ) : (
        <ul className="grid gap-0.5">
          {shown.map((marker) => (
            <li key={marker.id}>
              <button
                type="button"
                aria-label={format(te.jump, { time: formatClock(marker.offsetMs) })}
                onClick={() => onJump(Math.max(0, marker.offsetMs - 1500))}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', MARKER_STYLES[marker.kind])} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{markerText(marker)}</span>
                  <span className="block text-xs text-muted-foreground">{te.kinds[marker.kind]}</span>
                </span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatClock(marker.offsetMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface PersonPanelProps {
  projectId: string;
  current: PanelSessionRow;
  person: PanelPersonDto | null;
  otherSessions: readonly PanelSessionRow[];
  canSeePeople: boolean;
}

export function PersonPanel({ projectId, current, person, otherSessions, canSeePeople }: Readonly<PersonPanelProps>) {
  const { t, language } = useI18n();
  const tp = t.weldpanel.observe.session.person;
  const tm = t.weldpanel.observe.session.meta;
  const device = current.deviceType ? t.weldpanel.observe.common.devices[current.deviceType] : null;
  const profileId = current.userId ?? current.distinctId;
  const label = person ? personDisplayName(person) : visitorLabel(current, t.weldpanel.observe.common.anonymous);

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p className="text-sm font-medium">{label}</p>
        {person?.email && person.email !== label && <p className="text-sm text-muted-foreground">{person.email}</p>}
        {!person && <p className="text-sm text-muted-foreground">{tp.noProfile}</p>}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {device && (
            <>
              <dt className="text-muted-foreground">{tm.device}</dt>
              <dd>{device}</dd>
            </>
          )}
          {current.browser && (
            <>
              <dt className="text-muted-foreground">{tm.browser}</dt>
              <dd>{[current.browser, current.os].filter(Boolean).join(' · ')}</dd>
            </>
          )}
          {current.country && (
            <>
              <dt className="text-muted-foreground">{tm.country}</dt>
              <dd>{countryName(current.country, language)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{tm.duration}</dt>
          <dd>{formatDuration(current.durationSeconds)}</dd>
          <dt className="text-muted-foreground">{tm.pages}</dt>
          <dd>{current.pageviews}</dd>
          <dt className="text-muted-foreground">{tm.clicks}</dt>
          <dd>{current.clicks}</dd>
        </dl>
        <SignalBadges session={current} />
        {canSeePeople && person && (
          <div>
            <Button asChild variant="outline" size="sm">
              <Link href={`/weldpanel/users/${encodeURIComponent(profileId)}?project=${encodeURIComponent(projectId)}`}>{tp.openProfile}</Link>
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-medium">{tp.otherSessions}</h3>
        {otherSessions.length === 0 ? (
          <EmptyText>{tp.noOtherSessions}</EmptyText>
        ) : (
          <ul className="grid gap-1">
            {otherSessions.map((session) => (
              <li key={session.sessionId}>
                <Link
                  href={`/weldpanel/recordings/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(projectId)}`}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <span className="min-w-0 truncate">{formatDateTime(session.startedAt, language)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(session.durationSeconds)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
