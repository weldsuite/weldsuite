/**
 * Organizer and Participants cells shared by the Upcoming and History lists.
 */

import { Tooltip, TooltipTrigger, TooltipContent } from '@weldsuite/ui/components/tooltip';
import type { MeetingPerson } from '@/lib/weldmeet/meeting-people';

function PersonInitial({ person, className }: Readonly<{ person: MeetingPerson; className?: string }>) {
  const base = 'w-[23px] h-[23px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center shrink-0 overflow-hidden';
  if (person.avatar) {
    return <img src={person.avatar} alt={person.name} className={`${base} object-cover ${className ?? ''}`} />;
  }
  return (
    <div className={`${base} ${className ?? ''}`}>
      <span className="text-[10px] font-medium text-gray-600 dark:text-muted-foreground">
        {person.name?.charAt(0)?.toUpperCase() ?? '?'}
      </span>
    </div>
  );
}

export function OrganizerCell({ organizer }: Readonly<{ organizer: MeetingPerson | null }>) {
  if (!organizer) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-2">
      <PersonInitial person={organizer} />
      <span className="text-sm text-gray-700 dark:text-foreground truncate">{organizer.name}</span>
    </div>
  );
}

export function ParticipantsCell({
  people,
  countLabel,
}: Readonly<{
  people: MeetingPerson[];
  /** Tooltip of the "+N" chip, with `{count}` already filled in. */
  countLabel: (count: number) => string;
}>) {
  const ring = 'ring-2 ring-white dark:ring-background';
  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-1.5">
        {people.slice(0, 3).map((person) => (
          <Tooltip key={person.key}>
            <TooltipTrigger asChild>
              <div className="rounded-md">
                <PersonInitial person={person} className={ring} />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {person.name}
            </TooltipContent>
          </Tooltip>
        ))}
        {people.length > 3 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className={`w-[23px] h-[23px] rounded-md bg-gray-200 dark:bg-accent flex items-center justify-center ${ring}`}>
                <span className="text-[11px] font-semibold text-gray-600 dark:text-muted-foreground">
                  +{people.length - 3}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {countLabel(people.length)}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
