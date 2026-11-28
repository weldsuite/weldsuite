/**
 * The words and icon of each event in the invoice's "What happened" timeline:
 * a pure function of the event and the screen's copy, kept out of the panel
 * sections so each kind stays a few lines.
 */

import {
  Banknote,
  BellRing,
  CircleCheck,
  CircleX,
  Clock,
  CreditCard,
  Eye,
  FilePlus2,
  Link2Off,
  Mail,
  MailWarning,
  Send,
  Undo2,
} from 'lucide-react';
import type { ActivityTimelineItem } from '@weldsuite/ui/components/activity-timeline';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { useI18n } from '@/lib/i18n/provider';
import {
  claimAddsCosts,
  claimTotal,
  type ActivityEvent,
  type OnlinePaymentStatus,
} from '@/lib/weldbooks/invoice-activity';
import { methodLabel } from '@/lib/weldbooks/online-payments';
import type { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

export type PaymentWords = ReturnType<typeof useI18n>['t']['weldbooksPayments']['payment'];
type TimelineCopy = ReturnType<typeof useI18n>['t']['weldbooksSales']['timeline'];
type Format = ReturnType<typeof useWeldbooksFormat>;

/** What a timeline item is worded from. */
export interface TimelineContext {
  copy: TimelineCopy;
  pay: PaymentWords;
  methodNames: Readonly<Record<string, string>>;
  currency: InvoiceWithTax['currency'];
  quoteNumber: string | null;
  formatDate: Format['formatDate'];
  formatDateTime: Format['formatDateTime'];
  formatMoney: Format['formatMoney'];
}

type ItemBody = Omit<ActivityTimelineItem, 'id' | 'dateTime'>;
type EventOf<K extends ActivityEvent['kind']> = Extract<ActivityEvent, { kind: K }>;

/** "Paid with iDEAL", "Payment failed", ...: the provider's word for an online payment, in the owner's. */
export function onlineStatusItem(
  pay: PaymentWords,
  methodNames: Readonly<Record<string, string>>,
  status: OnlinePaymentStatus,
  method: string | null,
): Pick<ActivityTimelineItem, 'icon' | 'tone'> & { title: string } {
  switch (status) {
    case 'paid':
      return {
        icon: CircleCheck,
        tone: 'success',
        title: method ? pay.paidWith.replace('{method}', methodLabel(method, methodNames)) : pay.paid,
      };
    case 'failed':
      return { icon: CircleX, tone: 'danger', title: pay.failed };
    case 'expired':
      return { icon: CircleX, tone: 'warning', title: pay.expired };
    case 'canceled':
      return { icon: CircleX, tone: 'warning', title: pay.canceled };
    case 'authorized':
      return { icon: Clock, tone: 'info', title: pay.authorized };
    default:
      return { icon: Clock, tone: 'info', title: pay.pending };
  }
}

function toLine(copy: TimelineCopy, to: string): string | undefined {
  return to ? copy.to.replace('{to}', to) : undefined;
}

function createdItem(event: EventOf<'created'>, { copy, quoteNumber }: TimelineContext): ItemBody {
  return {
    icon: FilePlus2,
    title: event.quoteId ? copy.createdFromQuote.replace('{quote}', quoteNumber ?? copy.aQuote) : copy.created,
  };
}

function bouncedItem(event: EventOf<'bounced'>, { copy }: TimelineContext): ItemBody {
  return {
    icon: MailWarning,
    tone: 'danger',
    title: copy.bounced,
    description: [toLine(copy, event.to) ?? null, event.error].filter(Boolean).join(' · ') || undefined,
  };
}

function viewedItem(event: EventOf<'viewed'>, { copy }: TimelineContext, time: string | undefined): ItemBody {
  return {
    icon: Eye,
    tone: 'info',
    title: event.count > 1 ? copy.viewedTimes.replace('{count}', String(event.count)) : copy.viewed,
    time: time ? copy.lastViewed.replace('{time}', time) : undefined,
  };
}

function reminderItem(event: EventOf<'reminder'>, { copy, currency, formatMoney }: TimelineContext): ItemBody {
  const total = claimTotal(event.claim);
  const parts = [toLine(copy, event.to) ?? null];
  if (total && claimAddsCosts(event.claim)) {
    parts.push(copy.claims.replace('{amount}', formatMoney(total, currency)));
  }
  return {
    icon: BellRing,
    tone: 'warning',
    title: copy.reminderSent.replace('{level}', String(event.level)),
    description: parts.filter(Boolean).join(' · ') || undefined,
  };
}

function paymentItem(event: EventOf<'payment'>, { copy, currency, formatMoney }: TimelineContext): ItemBody {
  return {
    icon: Banknote,
    tone: 'success',
    title: (event.paidInFull ? copy.paidInFull : copy.paymentReceived).replace('{amount}', formatMoney(event.amount, currency)),
  };
}

function onlineStartedItem(event: EventOf<'online_started'>, { pay, currency, formatMoney }: TimelineContext): ItemBody {
  return {
    icon: CreditCard,
    tone: 'info',
    title: pay.started,
    description: event.amount ? pay.amount.replace('{amount}', formatMoney(event.amount, currency)) : undefined,
  };
}

function onlineReversedItem(event: EventOf<'online_reversed'>, { pay, currency, formatMoney }: TimelineContext): ItemBody {
  return {
    icon: Undo2,
    tone: 'danger',
    title: (event.reversal === 'chargeback' ? pay.chargeback : pay.refunded).replace('{amount}', formatMoney(event.amount, currency)),
  };
}

function nextReminderItem(event: EventOf<'next_reminder'>, { copy }: TimelineContext): ItemBody {
  return {
    icon: BellRing,
    upcoming: true,
    srPrefix: copy.planned,
    title: copy.nextReminder.replace('{level}', String(event.level)),
  };
}

function itemBody(event: ActivityEvent, context: TimelineContext, time: string | undefined): ItemBody {
  const { copy, pay, methodNames } = context;
  switch (event.kind) {
    case 'created':
      return createdItem(event, context);
    case 'marked_sent':
      return { icon: Send, tone: 'info', title: copy.markedSent };
    case 'emailed':
      return { icon: Mail, tone: 'info', title: copy.emailed, description: toLine(copy, event.to) };
    case 'bounced':
      return bouncedItem(event, context);
    case 'viewed':
      return viewedItem(event, context, time);
    case 'reminder':
      return reminderItem(event, context);
    case 'link_revoked':
      return { icon: Link2Off, tone: 'neutral', title: copy.linkRevoked };
    case 'payment':
      return paymentItem(event, context);
    case 'online_started':
      return onlineStartedItem(event, context);
    case 'online_status':
      return onlineStatusItem(pay, methodNames, event.status, event.method);
    case 'online_reversed':
      return onlineReversedItem(event, context);
    case 'next_reminder':
      return nextReminderItem(event, context);
  }
}

/** The words of one event, with the time formatted for the reader. */
export function timelineItem(event: ActivityEvent, context: TimelineContext): ActivityTimelineItem {
  const formatTime = event.kind === 'next_reminder' ? context.formatDate : context.formatDateTime;
  const time = event.at ? formatTime(event.at) : undefined;
  return { id: event.id, time, dateTime: event.at ?? undefined, ...itemBody(event, context, time) };
}
