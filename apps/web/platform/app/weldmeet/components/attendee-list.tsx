import { Link } from '@tanstack/react-router';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Badge } from '@weldsuite/ui/components/badge';
import { Users, UserCircle2, ExternalLink } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';

interface AttendeeRow {
  userId?: string;
  email?: string;
  name?: string;
  avatar?: string;
  role?: 'organizer' | 'attendee';
  status?: 'pending' | 'accepted' | 'declined' | 'tentative';
  workspaceMemberId?: string;
  contactId?: string;
}

interface AttendeeListProps {
  attendees: AttendeeRow[];
  /** Optional title — defaults to "Attendees". Hidden when empty. */
  title?: string;
}

/**
 * Renders a meeting's attendee list with each row linked to either:
 * - the team member profile (if matched to a workspace member), or
 * - the CRM contact profile (if matched to / auto-created as a contact).
 *
 * Attendees with neither link surface as plain rows — the resolver may
 * have failed silently or the data predates the linking feature.
 */
export function AttendeeList({ attendees, title }: AttendeeListProps) {
  const t = getTranslations('weldmeet');
  const resolvedTitle = title ?? t.attendeeList.title;
  if (!attendees || attendees.length === 0) return null;

  return (
    <div className="rounded-lg border bg-card p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Users className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{resolvedTitle}</h3>
        <span className="text-xs text-muted-foreground">({attendees.length})</span>
      </div>
      <div className="flex flex-col gap-1">
        {attendees.map((a, i) => (
          <AttendeeRow key={`${a.email ?? ''}-${a.userId ?? ''}-${i}`} attendee={a} />
        ))}
      </div>
    </div>
  );
}

function AttendeeRow({ attendee }: { attendee: AttendeeRow }) {
  const t = getTranslations('weldmeet');
  const initials = (attendee.name?.[0] ?? attendee.email?.[0] ?? '?').toUpperCase();

  const inner = (
    <>
      <Avatar className="h-7 w-7 !rounded-[8px]">
        {attendee.avatar && <AvatarImage src={attendee.avatar} className="!rounded-[8px]" />}
        <AvatarFallback className="text-[10px] !rounded-[8px]">{initials}</AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{attendee.name || attendee.email || t.attendeeList.unknown}</span>
          {attendee.role === 'organizer' && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">{t.attendeeList.organizer}</Badge>
          )}
        </div>
        {attendee.email && attendee.email !== attendee.name && (
          <p className="text-xs text-muted-foreground truncate">{attendee.email}</p>
        )}
      </div>
      <LinkBadge attendee={attendee} />
    </>
  );

  if (attendee.workspaceMemberId) {
    return (
      <Link
        to="/settings/team/$memberId"
        params={{ memberId: attendee.workspaceMemberId }}
        className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
      >
        {inner}
      </Link>
    );
  }

  if (attendee.contactId) {
    // Legacy contactId → People page (Companies/People migration). The exact
    // person isn't resolvable yet; once a contact→person backfill lands we
    // can deep-link to `/weldcrm/people/$id`.
    return (
      <Link
        to="/weldcrm/people"
        className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors"
      >
        {inner}
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3 px-2 py-1.5">
      {inner}
    </div>
  );
}

function LinkBadge({ attendee }: { attendee: AttendeeRow }) {
  const t = getTranslations('weldmeet');
  if (attendee.workspaceMemberId) {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
        <UserCircle2 className="h-3 w-3" />
        {t.attendeeList.teamMember}
      </Badge>
    );
  }
  if (attendee.contactId) {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
        <ExternalLink className="h-3 w-3" />
        {t.attendeeList.contact}
      </Badge>
    );
  }
  return null;
}
