
import { useState, useEffect, useRef } from 'react';
import { Plus, MoreVertical, Share2, Pencil, Trash2 } from 'lucide-react';
import { getTranslations } from '@/lib/i18n';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@weldsuite/ui/components/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { UserCalendar } from '@/hooks/queries/use-calendar-queries';
import { useDeleteUserCalendar } from '@/hooks/queries/use-calendar-queries';
import { CreateCalendarDialog } from './create-calendar-dialog';
import { ShareCalendarDialog } from './share-calendar-dialog';

// Stored in localStorage to remember which calendars are visible
function getVisibleCalendarIds(): Set<string> {
  try {
    const stored = localStorage.getItem('weldcalendar:visible');
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function setVisibleCalendarIds(ids: Set<string>) {
  localStorage.setItem('weldcalendar:visible', JSON.stringify([...ids]));
  // Dispatch event so calendar view can react
  window.dispatchEvent(new CustomEvent('weldcalendar:visibility-changed'));
}

export function getActiveCalendarIds(calendars: UserCalendar[]): string[] {
  const visible = getVisibleCalendarIds();
  // If nothing stored yet, all calendars are visible
  if (visible.size === 0) return calendars.map((c) => c.id);
  return calendars.filter((c) => visible.has(c.id)).map((c) => c.id);
}

interface CalendarSidebarSectionProps {
  calendars: UserCalendar[];
  isOwn: boolean;
}

export function CalendarSidebarSection({ calendars, isOwn }: CalendarSidebarSectionProps) {
  const t = getTranslations('weldcalendar');
  const [visibleIds, setVisibleIdsState] = useState<Set<string>>(() => {
    const stored = getVisibleCalendarIds();
    // Default: all visible
    return stored.size === 0 ? new Set(calendars.map((c) => c.id)) : stored;
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [shareCalendarId, setShareCalendarId] = useState<string | null>(null);
  const [editCalendar, setEditCalendar] = useState<UserCalendar | null>(null);
  const deleteCalendar = useDeleteUserCalendar();

  // Calendars known on first render. Anything that shows up later (e.g. one the
  // user just created) is "new" — as opposed to a calendar the user has
  // deliberately hidden, which is already in this set but absent from
  // `visibleIds`. New calendars default to visible/selected.
  const seenIdsRef = useRef<Set<string>>(new Set(calendars.map((c) => c.id)));
  useEffect(() => {
    const currentIds = calendars.map((c) => c.id);
    const newIds = currentIds.filter((id) => !seenIdsRef.current.has(id));
    seenIdsRef.current = new Set(currentIds);
    if (newIds.length === 0) return;

    // Reflect the new calendars as checked in this section right away.
    setVisibleIdsState((prev) => {
      const next = new Set(prev);
      newIds.forEach((id) => next.add(id));
      return next;
    });

    // Persist only when the user already has an explicit visibility set. When
    // nothing is stored, "all visible" is the default — the new calendar is
    // already shown, and writing this section's ids would clobber the sibling
    // section (own vs shared share one storage key). Otherwise merge into the
    // stored set so the other section's ids are preserved.
    const stored = getVisibleCalendarIds();
    if (stored.size === 0) {
      window.dispatchEvent(new CustomEvent('weldcalendar:visibility-changed'));
      return;
    }
    newIds.forEach((id) => stored.add(id));
    setVisibleCalendarIds(stored);
  }, [calendars]);

  const toggleCalendar = (id: string) => {
    const next = new Set(visibleIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setVisibleIdsState(next);
    setVisibleCalendarIds(next);
  };

  return (
    <>
      <SidebarMenu>
        {calendars.map((cal) => (
          <SidebarMenuItem key={cal.id} className="group/cal relative">
            {/* asChild renders the SidebarMenuButton styles onto a <div> so a
                Radix Checkbox (which is a <button>) is not nested inside another
                <button>, avoiding the React hydration warning. */}
            <SidebarMenuButton
              asChild
              className="cursor-pointer group-hover/cal:bg-sidebar-accent group-hover/cal:text-sidebar-accent-foreground"
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => toggleCalendar(cal.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleCalendar(cal.id);
                  }
                }}
              >
                <div className="flex items-center gap-2 flex-1 min-w-0 pr-0 group-hover/cal:pr-8">
                  <Checkbox
                    checked={visibleIds.has(cal.id)}
                    className={`h-4 w-4 pointer-events-none ${visibleIds.has(cal.id) ? '' : 'border-[1.5px]'}`}
                    style={{ borderColor: cal.color || '#3b82f6', backgroundColor: visibleIds.has(cal.id) ? (cal.color || '#3b82f6') : undefined }}
                  />
                  <span className="truncate text-sm">{cal.name}</span>
                </div>
              </div>
            </SidebarMenuButton>
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover/cal:opacity-100 pointer-events-none group-hover/cal:pointer-events-auto">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 hover:bg-black/[0.05] dark:hover:bg-black/20 rounded-md"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {(cal.isOwn || cal.permission === 'manage') && (
                    <DropdownMenuItem onClick={() => setEditCalendar(cal)}>
                      <Pencil className="h-4 w-4 mr-0.5" />
                      {t.createCalendar.edit}
                    </DropdownMenuItem>
                  )}
                  {(cal.isOwn || cal.permission === 'manage') && (
                    <DropdownMenuItem onClick={() => setShareCalendarId(cal.id)}>
                      <Share2 className="h-4 w-4 mr-0.5" />
                      {t.shareCalendar.title}
                    </DropdownMenuItem>
                  )}
                  {cal.isOwn && !cal.isDefault && (
                    <DropdownMenuItem
                      onClick={() => deleteCalendar.mutate(cal.id)}
                      variant="destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-0.5" />
                      {t.bookingPagesSidebar.delete}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>

      <CreateCalendarDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CreateCalendarDialog
        open={!!editCalendar}
        onOpenChange={(open) => { if (!open) setEditCalendar(null); }}
        editCalendar={editCalendar}
      />
      {shareCalendarId && (
        <ShareCalendarDialog
          calendarId={shareCalendarId}
          open={!!shareCalendarId}
          onOpenChange={(open) => { if (!open) setShareCalendarId(null); }}
        />
      )}
    </>
  );
}
