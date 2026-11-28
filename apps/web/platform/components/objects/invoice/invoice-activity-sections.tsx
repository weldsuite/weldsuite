/**
 * The sections the sales phase adds to the invoice panel's Details tab, each
 * gated on its own edition feature: "What happened" (a timeline of the
 * e-mails, views, reminders and payments), the Online link card (copy it,
 * revoke it), the Online payment card (can customers pay online, the last
 * payment, a refund or chargeback; phase 4b) and the Reminders card (the
 * workflow, the next step, send one now, pause).
 */

import { useState } from 'react';
import { toast } from 'sonner';
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
import { Link } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { ActivityTimeline, type ActivityTimelineItem } from '@weldsuite/ui/components/activity-timeline';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { CopyButton } from '@weldsuite/ui/components/copy-button';
import { PanelSection } from '@/components/objects/_shared/record-panel-parts';
import {
  isInvoiceEmailAvailable,
  isQuotesAvailable,
  isRemindersAvailable,
  useKnownLink,
  usePauseReminders,
  useReminderSettings,
  useRemindInvoice,
  useRevokeInvoiceLink,
} from '@/hooks/queries/use-weldbooks-sales-queries';
import { isOnlinePaymentsAvailable, usePaymentConnection } from '@/hooks/queries/use-weldbooks-payments-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import {
  buildActivity,
  claimAddsCosts,
  claimTotal,
  hasActiveLink,
  isOpenForPayment,
  linkMadeAt,
  nextReminder,
  recipients,
  type ActivityEvent,
  type OnlinePaymentStatus,
} from '@/lib/weldbooks/invoice-activity';
import {
  canPayOnline,
  lastOnlinePayment,
  lastReversal,
  methodLabel,
  methodList,
  paymentEntries,
} from '@/lib/weldbooks/online-payments';
import { rememberSettingsReturn } from '@/lib/weldbooks/settings-links';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { InvoiceConnections, useQuoteNumber } from './invoice-connections';

function statusOf(error: unknown): number | null {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : null;
  return typeof status === 'number' ? status : null;
}

// ----------------------------------------------------------------------------
// What happened
// ----------------------------------------------------------------------------

type PaymentWords = ReturnType<typeof useI18n>['t']['weldbooksPayments']['payment'];

/** "Paid with iDEAL", "Payment failed", ...: the provider's word for an online payment, in the owner's. */
function onlineStatusItem(
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

function useTimelineItems(invoice: InvoiceWithTax, settings: Parameters<typeof buildActivity>[1]): ActivityTimelineItem[] {
  const { t } = useI18n();
  const copy = t.weldbooksSales.timeline;
  const { formatDateTime, formatDate, formatMoney } = useWeldbooksFormat();
  const quoteNumber = useQuoteNumber(invoice.quoteId);
  const pay = t.weldbooksPayments.payment;
  const methodNames = t.weldbooksPayments.methodNames as Readonly<Record<string, string>>;

  const toItem = (event: ActivityEvent): ActivityTimelineItem => {
    const time = event.at ? (event.kind === 'next_reminder' ? formatDate(event.at) : formatDateTime(event.at)) : undefined;
    const base = { id: event.id, time, dateTime: event.at ?? undefined };
    switch (event.kind) {
      case 'created':
        return {
          ...base,
          icon: FilePlus2,
          title: event.quoteId ? copy.createdFromQuote.replace('{quote}', quoteNumber ?? copy.aQuote) : copy.created,
        };
      case 'marked_sent':
        return { ...base, icon: Send, tone: 'info', title: copy.markedSent };
      case 'emailed':
        return {
          ...base,
          icon: Mail,
          tone: 'info',
          title: copy.emailed,
          description: event.to ? copy.to.replace('{to}', event.to) : undefined,
        };
      case 'bounced':
        return {
          ...base,
          icon: MailWarning,
          tone: 'danger',
          title: copy.bounced,
          description: [event.to ? copy.to.replace('{to}', event.to) : null, event.error].filter(Boolean).join(' · ') || undefined,
        };
      case 'viewed':
        return {
          ...base,
          icon: Eye,
          tone: 'info',
          title: event.count > 1 ? copy.viewedTimes.replace('{count}', String(event.count)) : copy.viewed,
          time: time ? copy.lastViewed.replace('{time}', time) : undefined,
        };
      case 'reminder': {
        const total = claimTotal(event.claim);
        const parts = [event.to ? copy.to.replace('{to}', event.to) : null];
        if (total && claimAddsCosts(event.claim)) {
          parts.push(copy.claims.replace('{amount}', formatMoney(total, invoice.currency)));
        }
        return {
          ...base,
          icon: BellRing,
          tone: 'warning',
          title: copy.reminderSent.replace('{level}', String(event.level)),
          description: parts.filter(Boolean).join(' · ') || undefined,
        };
      }
      case 'link_revoked':
        return { ...base, icon: Link2Off, tone: 'neutral', title: copy.linkRevoked };
      case 'payment':
        return {
          ...base,
          icon: Banknote,
          tone: 'success',
          title: (event.paidInFull ? copy.paidInFull : copy.paymentReceived).replace(
            '{amount}',
            formatMoney(event.amount, invoice.currency),
          ),
        };
      case 'online_started':
        return {
          ...base,
          icon: CreditCard,
          tone: 'info',
          title: pay.started,
          description: event.amount ? pay.amount.replace('{amount}', formatMoney(event.amount, invoice.currency)) : undefined,
        };
      case 'online_status':
        return { ...base, ...onlineStatusItem(pay, methodNames, event.status, event.method) };
      case 'online_reversed':
        return {
          ...base,
          icon: Undo2,
          tone: 'danger',
          title: (event.reversal === 'chargeback' ? pay.chargeback : pay.refunded).replace(
            '{amount}',
            formatMoney(event.amount, invoice.currency),
          ),
        };
      case 'next_reminder':
        return {
          ...base,
          icon: BellRing,
          upcoming: true,
          srPrefix: copy.planned,
          title: copy.nextReminder.replace('{level}', String(event.level)),
        };
    }
  };

  return buildActivity(invoice, settings).map(toItem);
}

export function InvoiceTimeline({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.timeline;
  const settings = useReminderSettings();
  const items = useTimelineItems(invoice, settings.data);
  // Without anything beyond "created" there is nothing to tell yet.
  if (items.length < 2) return null;
  return (
    <PanelSection title={copy.title}>
      <ActivityTimeline label={copy.title} items={items} />
    </PanelSection>
  );
}

// ----------------------------------------------------------------------------
// Online link
// ----------------------------------------------------------------------------

function CardShell({ title, testId, children }: Readonly<{ title: string; testId: string; children: React.ReactNode }>) {
  return (
    <section aria-label={title} data-testid={testId} className="space-y-2 rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function OnlineLinkCard({ invoice, onSend }: Readonly<{ invoice: InvoiceWithTax; onSend: () => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.link;
  const { formatDateTime } = useWeldbooksFormat();
  const canUpdate = useCan('invoices:update');
  const known = useKnownLink('invoice', invoice.id);
  const revoke = useRevokeInvoiceLink();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const active = hasActiveLink(invoice);
  const madeAt = linkMadeAt(invoice);

  const revokeLink = () => {
    revoke.mutate(invoice.id, {
      onSuccess: () => {
        toast.success(copy.revoked);
        setConfirmOpen(false);
      },
      onError: (error) => toast.error(copy.revokeFailed, { description: error instanceof Error ? error.message : undefined }),
    });
  };

  return (
    <CardShell title={copy.title} testId="online-link-card">
      {active ? (
        <>
          <p className="text-[13px] text-muted-foreground">
            {copy.active}
            {madeAt ? ` ${copy.since.replace('{time}', formatDateTime(madeAt))}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {known ? (
              <CopyButton value={known} label={copy.copy} copiedLabel={copy.copied} failedLabel={copy.copyFailed} />
            ) : (
              // The server keeps only a nonce: sending again returns the same link.
              <Button type="button" variant="outline" size="sm" onClick={onSend} disabled={!canUpdate}>
                {copy.sendToCopy}
              </Button>
            )}
            {canUpdate ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
                {copy.revoke}
              </Button>
            ) : null}
          </div>
          {known ? null : <p className="text-xs text-muted-foreground">{copy.sameLink}</p>}
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">{copy.none}</p>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={copy.revokeTitle}
        description={copy.revokeDescription}
        confirmLabel={copy.revoke}
        cancelLabel={copy.keep}
        variant="destructive"
        loading={revoke.isPending}
        onConfirm={revokeLink}
      />
    </CardShell>
  );
}

// ----------------------------------------------------------------------------
// Online payment
// ----------------------------------------------------------------------------

/**
 * Whether customers can pay this invoice online, the last payment state, and
 * after a refund or chargeback a note that the money left through Mollie. Rust
 * only (`books-online-payments`).
 */
export function OnlinePaymentCard({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const copy = t.weldbooksPayments.card;
  const pay = t.weldbooksPayments.payment;
  const methodNames = t.weldbooksPayments.methodNames as Readonly<Record<string, string>>;
  const { formatDateTime, formatMoney } = useWeldbooksFormat();
  const canSetUp = useCan('accounts:update');
  const connectionQuery = usePaymentConnection();
  const { entityId } = useCurrentAccountingEntity();

  const last = lastOnlinePayment(invoice.emailHistory);
  const reversal = lastReversal(invoice.emailHistory);
  // Nothing to say about an invoice that is closed and never saw an online payment.
  if (!isOpenForPayment(invoice) && paymentEntries(invoice.emailHistory).length === 0) return null;
  if (connectionQuery.isLoading) return null;

  const connection = connectionQuery.data ?? null;
  const active = connection?.status === 'active';
  let availability: string;
  if (canPayOnline(connection)) {
    availability = copy.canPay.replace('{methods}', methodList(connection?.methods ?? [], methodNames, t.weldbooksPayments.and));
  } else if (!connection) availability = copy.notConnected;
  else if (active) availability = copy.noMethods;
  else availability = copy.needsReauth;

  let lastText: string | null = null;
  if (last) {
    const title = last.status === 'started' ? pay.started : onlineStatusItem(pay, methodNames, last.status, last.method).title;
    lastText = copy.lastPayment.replace('{status}', `${title} ${copy.on.replace('{time}', formatDateTime(last.at))}`);
  }

  const setUpLabel = connection && !active ? copy.reconnect : copy.setUp;
  const needsSetUp = !canPayOnline(connection);

  return (
    <CardShell title={copy.title} testId="online-payment-card">
      <p className="text-[13px] text-muted-foreground" data-testid="online-payment-availability">
        {availability}
      </p>
      {connection?.testmode && active ? <p className="text-xs text-muted-foreground">{copy.testMode}</p> : null}
      {lastText ? (
        <p className="text-[13px] font-medium" data-testid="online-payment-last">
          {lastText}
        </p>
      ) : null}
      {reversal ? (
        <div className="space-y-1" role="status" data-testid="online-payment-reversal">
          <p className="text-[13px]">
            {copy.reversed[reversal.kind].replace('{amount}', formatMoney(reversal.amount, invoice.currency))}
          </p>
          {connection?.bankAccountId ? (
            <Link
              to="/weldbooks/banking/process"
              search={{ accountId: connection.bankAccountId }}
              className="text-[13px] text-primary underline-offset-4 hover:underline"
            >
              {copy.reversed.open}
            </Link>
          ) : null}
        </div>
      ) : null}
      {needsSetUp && canSetUp && entityId ? (
        <Link
          to="/settings/entities/$id/edit"
          params={{ id: entityId }}
          search={{ tab: 'weldbooks' }}
          onClick={rememberSettingsReturn}
          className="inline-block text-[13px] text-primary underline-offset-4 hover:underline"
        >
          {setUpLabel}
        </Link>
      ) : null}
    </CardShell>
  );
}

// ----------------------------------------------------------------------------
// Reminders
// ----------------------------------------------------------------------------

export function RemindersCard({ invoice }: Readonly<{ invoice: InvoiceWithTax }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.reminders;
  const { formatDate } = useWeldbooksFormat();
  const canUpdate = useCan('invoices:update');
  const settings = useReminderSettings();
  const remind = useRemindInvoice();
  const pause = usePauseReminders();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const open = isOpenForPayment(invoice);
  const level = invoice.reminderLevel ?? 0;
  // Nothing to say about an invoice that is paid and never got a reminder.
  if (!open && level === 0) return null;

  const paused = invoice.remindersPaused === true;
  const next = nextReminder(invoice, settings.data);
  const steps = settings.data?.steps ?? [];
  const nextStep = [...steps].sort((a, b) => a.level - b.level).find((step) => step.level > level);
  const workflow = settings.data?.enabled === false ? copy.off : copy.workflowName;

  let status: string;
  if (!open) status = copy.sentCount.replace('{level}', String(level));
  else if (paused) status = copy.paused;
  else if (next) {
    status = (next.auto ? copy.nextAuto : copy.nextManual)
      .replace('{level}', String(next.step.level))
      .replace('{date}', formatDate(next.date));
  } else if (settings.data?.enabled === false) status = copy.offHint;
  else status = copy.allSent;

  const sendNow = () => {
    remind.mutate(invoice.id, {
      onSuccess: (res) => {
        toast.success(copy.sentNow.replace('{level}', String(res.data.reminder.level)).replace('{to}', recipients(res.data.reminder.to)));
        setConfirmOpen(false);
      },
      onError: (error) => {
        setConfirmOpen(false);
        const code = statusOf(error);
        toast.error(copy.sendFailed, {
          description: code === 409 ? copy.notOpen : code === 400 ? copy.noRecipient : error instanceof Error ? error.message : undefined,
        });
      },
    });
  };

  const togglePause = () => {
    pause.mutate(
      { id: invoice.id, paused: !paused },
      {
        onSuccess: () => toast.success(paused ? copy.resumed : copy.pausedToast),
        onError: (error) => toast.error(copy.pauseFailed, { description: error instanceof Error ? error.message : undefined }),
      },
    );
  };

  return (
    <CardShell title={copy.title} testId="reminders-card">
      <p className="text-[13px] font-medium">{workflow}</p>
      <p className="text-[13px] text-muted-foreground" data-testid="reminder-status">
        {status}
      </p>
      {open && canUpdate ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" onClick={() => setConfirmOpen(true)} disabled={!nextStep || remind.isPending}>
            {copy.sendNow}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={togglePause} disabled={pause.isPending}>
            {paused ? copy.resume : copy.pause}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={copy.confirmTitle.replace('{level}', String(nextStep?.level ?? level + 1))}
        description={copy.confirmDescription.replace('{to}', invoice.contactEmail ?? copy.theContact)}
        confirmLabel={copy.sendNow}
        cancelLabel={copy.cancel}
        loading={remind.isPending}
        onConfirm={sendNow}
      />
    </CardShell>
  );
}

/**
 * Connections, the two cards and the timeline, at the top of the Details tab.
 * Each is shown only where its edition feature is: Global's panel is unchanged.
 */
export function InvoiceSalesSections({
  invoice,
  isCreditMemo,
  onSend,
  onOpenPayments,
}: Readonly<{
  invoice: InvoiceWithTax;
  isCreditMemo: boolean;
  onSend: () => void;
  onOpenPayments: () => void;
}>) {
  const email = isInvoiceEmailAvailable();
  const reminders = isRemindersAvailable() && !isCreditMemo;
  const online = isOnlinePaymentsAvailable() && !isCreditMemo;
  if (!email && !reminders && !online && !isQuotesAvailable()) return null;
  // A draft has nothing to tell and nothing to remind about yet.
  const sent = invoice.status !== 'draft';
  return (
    <div className="@container space-y-4 px-4 pt-4" data-testid="invoice-sales-sections">
      <InvoiceConnections invoice={invoice} onOpenPayments={onOpenPayments} />
      {sent && (email || reminders || online) ? (
        <div className="grid gap-3 @md:grid-cols-2">
          {email ? <OnlineLinkCard invoice={invoice} onSend={onSend} /> : null}
          {online ? <OnlinePaymentCard invoice={invoice} /> : null}
          {reminders ? <RemindersCard invoice={invoice} /> : null}
        </div>
      ) : null}
      {email || reminders || online ? <InvoiceTimeline invoice={invoice} /> : null}
    </div>
  );
}
