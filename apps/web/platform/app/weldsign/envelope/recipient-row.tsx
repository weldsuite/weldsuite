/**
 * One recipient of a sent request: where they stand, why they declined, when
 * they were last reminded, and (for owners of an open request) a menu to send
 * a signer a new link or correct an email address.
 */

import { CheckCircle2, Circle, Clock, Eye, Mail, MoreHorizontal, Pencil, Send, XCircle, type LucideIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import type { SignRecipientDto, SignRecipientStatus } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { canCorrectEmail, isSigningNow } from '../lib/recipients';
import { recipientColor } from '../lib/recipient-colors';
import { useDateTime } from '../lib/use-date-time';

const STATUS_ICON: Record<SignRecipientStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: Circle, className: 'text-muted-foreground' },
  sent: { icon: Mail, className: 'text-sky-600' },
  opened: { icon: Eye, className: 'text-amber-600' },
  signed: { icon: CheckCircle2, className: 'text-emerald-600' },
  declined: { icon: XCircle, className: 'text-destructive' },
};

interface RecipientRowProps {
  recipient: SignRecipientDto;
  colorIndex: number;
  /** Show the signing order (#2): the request has a signing order and this is a signer. */
  showOrder: boolean;
  /** The caller may remind, resend and correct emails on this request. */
  canRemind: boolean;
  /** A resend is on its way; keeps the menu from sending twice. */
  resending: boolean;
  onResend: (recipient: SignRecipientDto) => void;
  onCorrect: (recipient: SignRecipientDto) => void;
}

export function RecipientRow({ recipient, colorIndex, showOrder, canRemind, resending, onResend, onCorrect }: Readonly<RecipientRowProps>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const when = useDateTime();
  const status = STATUS_ICON[recipient.status];
  const isCopy = recipient.role === 'cc';
  const Icon = isCopy ? Clock : status.icon;
  const name = recipient.name || recipient.email || '';
  const hasActions = canRemind && (isSigningNow(recipient) || canCorrectEmail(recipient));

  const statusLabel = () => {
    if (isCopy) return to.copy;
    if (recipient.status === 'signed' && recipient.signedAt) return format(to.signedAt, { date: when(recipient.signedAt) });
    return to.statuses[recipient.status];
  };

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      {/* Phone: name and menu on the first line, order and status under the name. Wider: all in one line. */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: recipientColor(colorIndex).border }} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="truncate text-xs text-muted-foreground">{recipient.email}</p>
        </div>
        <div className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:col-auto sm:row-auto sm:justify-end">
          {showOrder && <span className="text-xs tabular-nums text-muted-foreground">#{recipient.routingOrder}</span>}
          <span className={cn('flex items-center gap-1.5 text-xs', isCopy ? 'text-muted-foreground' : status.className)}>
            <Icon className="size-4 shrink-0" />
            {statusLabel()}
          </span>
        </div>
        {canRemind && (
          // The slot stays when a recipient has no actions, so the statuses line up.
          <div className="col-start-3 row-start-1 size-8 sm:col-auto sm:row-auto">
            {hasActions && (
              <RecipientMenu
                recipient={recipient}
                label={format(to.recipientActions, { name })}
                resending={resending}
                onResend={onResend}
                onCorrect={onCorrect}
              />
            )}
          </div>
        )}
      </div>
      <RecipientNotes recipient={recipient} />
    </li>
  );
}

/** Under the row: why they declined, or when a signer who has not acted was last reminded. */
function RecipientNotes({ recipient }: Readonly<{ recipient: SignRecipientDto }>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const when = useDateTime();

  const notes: string[] = [];
  if (recipient.status === 'declined' && recipient.declineReason) {
    notes.push(format(to.declineReason, { reason: recipient.declineReason }));
  }
  if (isSigningNow(recipient) && recipient.lastRemindedAt) {
    // "Reminded Oct 24, 10:00 · 2 automatic reminders"
    const reminded = format(to.lastReminded, { date: when(recipient.lastRemindedAt) });
    const automatic = recipient.remindersSent === 1 ? to.automaticReminders : to.automaticRemindersPlural;
    notes.push(recipient.remindersSent > 0 ? `${reminded} · ${format(automatic, { count: recipient.remindersSent })}` : reminded);
  }

  return notes.map((note) => (
    <p key={note} className="break-words pl-[1.375rem] text-xs text-muted-foreground">
      {note}
    </p>
  ));
}

interface RecipientMenuProps {
  recipient: SignRecipientDto;
  label: string;
  resending: boolean;
  onResend: (recipient: SignRecipientDto) => void;
  onCorrect: (recipient: SignRecipientDto) => void;
}

function RecipientMenu({ recipient, label, resending, onResend, onCorrect }: Readonly<RecipientMenuProps>) {
  const { t } = useI18n();
  const to = t.weldsign.overview;
  const canResend = isSigningNow(recipient);
  const canCorrect = canCorrectEmail(recipient);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canResend && (
          <DropdownMenuItem disabled={resending} onSelect={() => onResend(recipient)}>
            <Send />
            {to.resendLink}
          </DropdownMenuItem>
        )}
        {canCorrect && (
          <DropdownMenuItem onSelect={() => onCorrect(recipient)}>
            <Pencil />
            {to.correctEmail}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
