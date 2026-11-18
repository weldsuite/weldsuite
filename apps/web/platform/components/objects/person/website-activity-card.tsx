/**
 * "Website activity" on a WeldCRM person: when WeldPanel has a profile with
 * this person's email, shows when they were last on the site, what they did
 * lately and their recordings, with links into WeldPanel. Shown only when
 * WeldPanel is installed, analytics exist in this edition, the viewer may read
 * profiles, and the API returns at least one profile; otherwise it renders
 * nothing (a person who never visited needs no empty card).
 */

import { Globe } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { useAppAccess } from '@/hooks/use-app-access';
import { useWeldPanelPeopleByEmail } from '@/hooks/queries/use-weldpanel-queries';
import { isFeatureAvailable } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { formatDuration } from '@/app/weldpanel/lib/format';

const RECENT_EVENTS = 4;
const RECENT_SESSIONS = 3;

/** `$pageview` reads as "Viewed /pricing"; custom events by their name. */
function eventLabel(event: { name: string; path: string | null }, viewed: string): string {
  if (event.name === '$pageview') return event.path ? `${viewed} ${event.path}` : viewed;
  return event.name.startsWith('$') ? event.name.slice(1) : event.name;
}

export function WebsiteActivityCard({ email }: Readonly<{ email: string | null | undefined }>) {
  const { t, language, format } = useI18n();
  const tw = t.crm.websiteActivity;
  const { isInstalled, isLoading } = useAppAccess('weldpanel');
  const canReadPeople = useCan('panel_people:read');
  const canWatch = useCan('panel_recordings:read');
  const enabled = !isLoading && isInstalled && canReadPeople && isFeatureAvailable('panel-analytics');
  const { data } = useWeldPanelPeopleByEmail(enabled ? email : null);

  if (!enabled || !data || data.people.length === 0) return null;
  const when = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  const day = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  return (
    <section className="mt-3 space-y-3 rounded-lg border bg-card p-3" aria-label={tw.title} data-testid="website-activity-card">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Globe className="size-4 text-muted-foreground" aria-hidden />
        {tw.title}
      </h3>
      {data.people.map((entry) => {
        const recordings = entry.sessions.filter((s) => s.hasRecording).slice(0, RECENT_SESSIONS);
        return (
          <div key={`${entry.projectId}:${entry.person.userId}`} className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {data.people.length > 1 && <p className="truncate text-xs font-medium">{entry.projectName}</p>}
                <p className="text-xs text-muted-foreground">{format(tw.lastSeen, { date: when.format(new Date(entry.person.lastSeen)) })}</p>
              </div>
              <Link
                href={`/weldpanel/users/${encodeURIComponent(entry.person.userId)}?project=${encodeURIComponent(entry.projectId)}`}
                className="shrink-0 text-xs font-medium underline underline-offset-4"
              >
                {tw.openInWeldPanel}
              </Link>
            </div>

            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{tw.recentEvents}</p>
              {entry.recentEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tw.noEvents}</p>
              ) : (
                <ul className="space-y-1">
                  {entry.recentEvents.slice(0, RECENT_EVENTS).map((event) => (
                    <li key={event.eventId} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">{eventLabel(event, tw.viewed)}</span>
                      <span className="shrink-0 text-muted-foreground">{day.format(new Date(event.ts))}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {canWatch && recordings.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{tw.recordings}</p>
                <ul className="space-y-1">
                  {recordings.map((session) => (
                    <li key={session.sessionId} className="flex items-baseline justify-between gap-2 text-xs">
                      <Link
                        href={`/weldpanel/recordings/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(entry.projectId)}`}
                        className="min-w-0 truncate underline underline-offset-4"
                      >
                        {format(tw.watchSession, { date: when.format(new Date(session.startedAt)) })}
                      </Link>
                      <span className="shrink-0 text-muted-foreground">{formatDuration(session.durationSeconds)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
