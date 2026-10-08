
import { useState, useEffect, useRef } from 'react';
import { MoreVertical, Share2, Pencil, Trash2 } from 'lucide-react';
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
import { CreateCalendarDialog } from './create-calendar-dialog';
import { DeleteCalendarDialog } from './delete-calendar-dialog';
import { ShareCalendarDialog } from './share-calendar-dialog';
import { activateOnKey } from '@/lib/activate-on-key';

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

// The row menu shows on hover, while anything in the row has keyboard focus,
// while it is open, and always on touch screens (no hover), so it is never
// reachable by mouse only (TASK-745 / TASK-758).
const ROW_MENU_CLASS = [
  'absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5',
  'opacity-0 pointer-events-none',
  'group-hover/cal:opacity-100 group-hover/cal:pointer-events-auto',
  'group-focus-within/cal:opacity-100 group-focus-within/cal:pointer-events-auto',
  'has-[[data-state=open]]:opacity-100 has-[[data-state=open]]:pointer-events-auto',
  '[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto',
].join(' ');

/** Room for the menu button next to the name, whenever the menu is visible. */
const ROW_MENU_PADDING_CLASS =
  'group-hover/cal:pr-8 group-focus-within/cal:pr-8 [@media(hover:none)]:pr-8';

interface CalendarSidebarSectionProps {
  calendars: UserCalendar[];
}

export function CalendarSidebarSection({ calendars }: Readonly<CalendarSidebarSectionProps>) {
  const t = getTranslations('weldcalendar');
  const [visibleIds, setVisibleIdsState] = useState<Set<string>>(() => {
    const stored = getVisibleCalendarIds();
    // Default: all visible
    return stored.size === 0 ? new Set(calendars.map((c) => c.id)) : stored;
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [shareCalendar, setShareCalendar] = useState<UserCalendar | null>(null);
  const [editCalendar, setEditCalendar] = useState<UserCalendar | null>(null);
  const [deleteCalendar, setDeleteCalendar] = useState<UserCalendar | null>(null);

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
        {calendars.map((cal) => {
          const canManage = cal.isOwn || cal.permission === 'manage';
          const canDelete = cal.isOwn && !cal.isDefault;
          const hasMenu = canManage || canDelete;
          return (
            <SidebarMenuItem key={cal.id} className="group/cal relative">
              {/* asChild renders the SidebarMenuButton styles onto a <div> so a
                  Radix Checkbox (which is a <button>) is not nested inside another
                  <button>, avoiding the React hydration warning. */}
              <SidebarMenuButton
                asChild
                className="cursor-pointer group-hover/cal:bg-sidebar-accent group-hover/cal:text-sidebar-accent-foreground"
              >
                <div
                  role="checkbox"
                  aria-checked={visibleIds.has(cal.id)}
                  aria-label={cal.name}
                  tabIndex={0}
                  onClick={() => toggleCalendar(cal.id)}
                  onKeyDown={activateOnKey(() => toggleCalendar(cal.id))}
                >
                  <div
                    className={`flex items-center gap-2 flex-1 min-w-0 pr-0 ${hasMenu ? ROW_MENU_PADDING_CLASS : ''}`}
                  >
                    <Checkbox
                      aria-hidden="true"
                      tabIndex={-1}
                      checked={visibleIds.has(cal.id)}
                      className={`h-4 w-4 pointer-events-none ${visibleIds.has(cal.id) ? '' : 'border-[1.5px]'}`}
                      style={{ borderColor: cal.color || '#3b82f6', backgroundColor: visibleIds.has(cal.id) ? (cal.color || '#3b82f6') : undefined }}
                    />
                    <span className="truncate text-sm">{cal.name}</span>
                  </div>
                </div>
              </SidebarMenuButton>
              {hasMenu && (
                <div className={ROW_MENU_CLASS}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t.deleteCalendar.menuLabel.replace('{name}', cal.name)}
                        className="h-6 w-6 hover:bg-black/[0.05] dark:hover:bg-black/20 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MoreVertical className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      {canManage && (
                        <DropdownMenuItem onClick={() => setEditCalendar(cal)}>
                          <Pencil className="h-4 w-4 mr-0.5" />
                          {t.createCalendar.edit}
                        </DropdownMenuItem>
                      )}
                      {canManage && (
                        <DropdownMenuItem onClick={() => setShareCalendar(cal)}>
                          <Share2 className="h-4 w-4 mr-0.5" />
                          {t.shareCalendar.title}
                        </DropdownMenuItem>
                      )}
                      {canDelete && (
                        <DropdownMenuItem
                          onClick={() => setDeleteCalendar(cal)}
                          variant="destructive"
                        >
                          <Trash2 className="h-4 w-4 mr-0.5" />
                          {t.deleteCalendar.menuDelete}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>

      <CreateCalendarDialog open={createOpen} onOpenChange={setCreateOpen} />
      <CreateCalendarDialog
        open={!!editCalendar}
        onOpenChange={(open) => { if (!open) setEditCalendar(null); }}
        editCalendar={editCalendar}
      />
      {shareCalendar && (
        <ShareCalendarDialog
          calendarId={shareCalendar.id}
          ownerId={shareCalendar.ownerId}
          open={!!shareCalendar}
          onOpenChange={(open) => { if (!open) setShareCalendar(null); }}
        />
      )}
      <DeleteCalendarDialog
        calendar={deleteCalendar}
        onOpenChange={(open) => { if (!open) setDeleteCalendar(null); }}
      />
    </>
  );
}
