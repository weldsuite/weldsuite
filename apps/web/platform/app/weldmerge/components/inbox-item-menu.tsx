import { useState } from 'react';
import { Archive, ArchiveRestore, BellOff, Clock, MailOpen, Mail, MoreHorizontal } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Calendar } from '@weldsuite/ui/components/calendar';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { MergeInboxItem } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { UpdateMergeInboxItemInput } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { MergeInboxView } from '@/hooks/queries/use-weldmerge-sync-queries';
import { useI18n } from '@/lib/i18n/provider';
import { snoozeUntilDate, snoozeUntilNextWeek, snoozeUntilTomorrow } from '../lib/snooze';

/** Pick a day to snooze an item until; it wakes at 09:00 that day. */
function SnoozeDateDialog({
  open,
  onOpenChange,
  onPick,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; onPick: (until: string) => void }>) {
  const { t } = useI18n();
  const ti = t.weldmerge.sync.inbox;
  const [day, setDay] = useState<Date | undefined>(undefined);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs">
        <DialogHeader>
          <DialogTitle>{ti.snoozePickTitle}</DialogTitle>
        </DialogHeader>
        <div className="flex justify-center">
          <Calendar mode="single" selected={day} onSelect={setDay} disabled={{ before: today }} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button
            disabled={!day}
            onClick={() => {
              if (day) onPick(snoozeUntilDate(day));
              onOpenChange(false);
            }}
          >
            {ti.snoozePickConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The per-item actions of an inbox row: read or unread, snooze (until tomorrow,
 * next week, or a picked day), archive. In the snoozed and archived views the
 * item is woken or moved back to the inbox instead.
 */
export function InboxItemMenu({
  item,
  view,
  onChange,
}: Readonly<{
  item: MergeInboxItem;
  view: MergeInboxView;
  onChange: (item: MergeInboxItem, input: UpdateMergeInboxItemInput) => void;
}>) {
  const { t } = useI18n();
  const ti = t.weldmerge.sync.inbox;
  const [picking, setPicking] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label={ti.actions}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onChange(item, { read: !item.read })}>
            {item.read ? <Mail /> : <MailOpen />}
            {item.read ? ti.markUnread : ti.markRead}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {view === 'archived' ? (
            <DropdownMenuItem onSelect={() => onChange(item, { archived: false })}>
              <ArchiveRestore />
              {ti.unarchive}
            </DropdownMenuItem>
          ) : (
            <>
              {view === 'snoozed' && (
                <DropdownMenuItem onSelect={() => onChange(item, { snoozedUntil: null })}>
                  <BellOff />
                  {ti.wake}
                </DropdownMenuItem>
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Clock />
                  {ti.snooze}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={() => onChange(item, { snoozedUntil: snoozeUntilTomorrow() })}>
                    {ti.snoozeTomorrow}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onChange(item, { snoozedUntil: snoozeUntilNextWeek() })}>
                    {ti.snoozeNextWeek}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setPicking(true)}>{ti.snoozePick}</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={() => onChange(item, { archived: true })}>
                <Archive />
                {ti.archive}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SnoozeDateDialog
        open={picking}
        onOpenChange={setPicking}
        onPick={(until) => onChange(item, { snoozedUntil: until })}
      />
    </>
  );
}
