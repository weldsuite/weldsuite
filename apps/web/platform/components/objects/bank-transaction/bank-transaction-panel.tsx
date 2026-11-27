/**
 * Bank transaction object panel (WeldBooks): one bank line, what it paid and
 * what it booked.
 *
 * Built on the same shell as the other WeldBooks panels
 * (`useObjectPanelShell` + `EntityDetailView`), so it stacks, goes fullscreen
 * and deep-links with `?stack=bank_transaction:<id>`.
 *
 * Tabs: Details · History. The Details tab holds the summary of the line, its
 * Connections (payment and the documents it settled, journal entry, category
 * and VAT rate, deposit, contact, inbox documents; each a chip that stacks
 * that record) and the facts of the import. A processed line offers Undo; a
 * line still to process offers Match (the reconcile screen with this line
 * selected) and Ignore.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  AlignLeft,
  ArrowLeftRight,
  Banknote,
  BookText,
  Building2,
  CalendarDays,
  CircleDot,
  CreditCard,
  EllipsisVertical,
  FileText,
  Layers,
  Link as LinkIcon,
  Percent,
  PiggyBank,
  Receipt,
  StickyNote,
  Tag,
  Undo2,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { RecordChip, type RecordChipTone } from '@weldsuite/ui/components/record-chip';
import { InboxDocumentChip } from '@/components/accounting/inbox-document-chip';
import { useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { RecordLink, useRecordLink } from '@/components/object-panel/record-link';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { PanelRow, PanelSection, useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import { useBankAccount, useExcludeBankLine, useUnreconcileBankLine } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useRouter } from '@/lib/router';
import type { BankLineLinks, BankLineProcessedAs } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { withQuery } from '@/lib/with-query';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { getBankTransactionTabs, type BankTransactionTab } from './bank-transaction-tabs';
import { useBankTransactionLinks } from './use-bank-transaction-links';

const BANK_TRANSACTION_PANEL_WIDTH = 480;
const OBJECT_TYPE = 'bank_transaction';

const PILL = 'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none';
const PILL_GREEN = 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950';
const PILL_GRAY = 'text-gray-600 dark:text-muted-foreground bg-gray-100 dark:bg-secondary';
const PILL_AMBER = 'text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950';

type Translations = ReturnType<typeof useI18n>['t'];

const PROCESSED_PILL: Record<BankLineProcessedAs, string> = {
  payment: PILL_GREEN,
  deposit: PILL_GREEN,
  category: PILL_GREEN,
  excluded: PILL_GRAY,
  unprocessed: PILL_AMBER,
};

/** A line that is neither booked nor matched, and not ignored: it still needs a person. */
export function isUnprocessed(processedAs: BankLineProcessedAs): boolean {
  return processedAs === 'unprocessed';
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '';
}

// ─── Header ────────────────────────────────────────────────────────────────

function Title({
  links,
  currency,
  t,
}: Readonly<{ links?: BankLineLinks; currency: string | null; t: Translations }>) {
  const { formatMoney } = useWeldbooksFormat();
  const tp = t.accounting.bankTransactionPanel;
  if (!links) return <div className="h-4 w-32 rounded bg-muted animate-pulse" />;
  const amount = Number(links.transaction.amount) || 0;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'relative top-px truncate text-[15px] font-medium tabular-nums',
          amount > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground',
        )}
        data-testid="bank-transaction-amount"
      >
        {amount > 0 ? '+' : ''}
        {formatMoney(links.transaction.amount, currency)}
      </span>
      <span className={cn(PILL, PROCESSED_PILL[links.processedAs], 'flex-shrink-0')}>
        {tp.processedAs[links.processedAs]}
      </span>
    </div>
  );
}

function Actions({
  links,
  canEdit,
  onUndo,
  onIgnore,
  onMatch,
  t,
}: Readonly<{
  links?: BankLineLinks;
  canEdit: boolean;
  onUndo: () => void;
  onIgnore: () => void;
  onMatch: () => void;
  t: Translations;
}>) {
  const st = useTranslations();
  const copyLink = useCopyPanelLink('/weldbooks/banking/transactions', OBJECT_TYPE, links?.transaction.id ?? '');
  if (!links) return null;
  const tp = t.accounting.bankTransactionPanel;
  const toProcess = isUnprocessed(links.processedAs);

  return (
    <div className="flex items-center gap-1">
      {canEdit && toProcess ? (
        <>
          <Button size="sm" onClick={onMatch} data-testid="match-bank-transaction">
            <ArrowLeftRight className="h-4 w-4" />
            {tp.actions.match}
          </Button>
          <Button variant="outline" size="sm" onClick={onIgnore} data-testid="ignore-bank-transaction">
            {tp.actions.ignore}
          </Button>
        </>
      ) : null}
      {canEdit && !toProcess ? (
        <Button variant="outline" size="sm" onClick={onUndo} data-testid="undo-bank-transaction">
          <Undo2 className="h-4 w-4" />
          {tp.actions.undo}
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={st('sweep.entities.moreActions')}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// ─── Connections ───────────────────────────────────────────────────────────

/** A document status as a chip tone: settled green, open amber, void or rejected red. */
function documentTone(status: string | null): RecordChipTone | undefined {
  if (!status) return undefined;
  if (status === 'paid') return 'success';
  if (status === 'void' || status === 'cancelled' || status === 'rejected') return 'danger';
  if (status === 'overdue') return 'warning';
  return 'neutral';
}

function ConnectionRow({
  icon: Icon,
  label,
  children,
}: Readonly<{ icon: typeof Banknote; label: string; children: ReactNode }>) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="flex w-[8.5rem] flex-shrink-0 items-center gap-2 pt-0.5 text-sm text-muted-foreground">
        <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">{children}</div>
    </div>
  );
}

function Connections({ links, currency, t }: Readonly<{ links: BankLineLinks; currency: string | null; t: Translations }>) {
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tp = t.accounting.bankTransactionPanel;
  const tc = tp.connections;
  const link = useRecordLink();
  const methods = t.accounting.paymentMethods as Record<string, string>;

  const { payment, allocations, journalEntry, category, deposit, contact, documents } = links;
  const empty =
    !payment && allocations.length === 0 && !journalEntry && !category && !deposit && !contact && documents.length === 0;

  const documentLabel = (type: 'invoice' | 'bill', number: string | null) =>
    number ?? (type === 'invoice' ? tc.invoiceFallback : tc.billFallback);
  const statusLabels: Record<'invoice' | 'bill', Record<string, string>> = {
    invoice: t.accounting.statusLabels.invoice,
    bill: t.accounting.statusLabels.bill,
  };

  return (
    <PanelSection title={tc.title}>
      {empty ? <p className="text-sm text-muted-foreground">{tc.none}</p> : null}
      <div className="divide-y divide-border/60">
        {payment || allocations.length > 0 ? (
          <ConnectionRow icon={Banknote} label={tc.payment}>
            {payment ? (
              <span className="text-sm tabular-nums">
                {[
                  payment.method ? (methods[payment.method] ?? payment.method) : null,
                  formatDate(payment.date),
                  formatMoney(payment.amount, payment.currency ?? currency),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            ) : null}
            {allocations.map((allocation) => {
              const target = link({ type: allocation.documentType, id: allocation.documentId });
              const statusMap = statusLabels[allocation.documentType];
              return (
                <RecordChip
                  key={`${allocation.documentType}:${allocation.documentId}`}
                  icon={allocation.documentType === 'invoice' ? FileText : Receipt}
                  label={documentLabel(allocation.documentType, allocation.number)}
                  secondary={formatMoney(allocation.amount, currency)}
                  tone={documentTone(allocation.status)}
                  statusLabel={allocation.status ? (statusMap[allocation.status] ?? allocation.status) : undefined}
                  href={target.href}
                  onOpen={target.onOpen}
                />
              );
            })}
          </ConnectionRow>
        ) : null}

        {journalEntry ? (
          <ConnectionRow icon={BookText} label={tc.journalEntry}>
            <RecordLink
              type="journal_entry"
              id={journalEntry.id}
              label={journalEntry.entryNumber ?? t.accounting.statusLabels.journalEntry.fallback}
              secondary={journalEntry.entryNumber ? formatDate(journalEntry.date) : undefined}
            />
          </ConnectionRow>
        ) : null}

        {category ? (
          <ConnectionRow icon={Tag} label={tc.category}>
            <RecordLink
              type="ledger_account"
              id={category.accountId}
              label={
                category.accountName
                  ? [category.accountCode, category.accountName].filter(Boolean).join(' — ')
                  : tc.accountFallback
              }
            />
          </ConnectionRow>
        ) : null}

        {category?.taxRateName ? (
          <ConnectionRow icon={Percent} label={tc.vatRate}>
            <span>{category.taxRateName}</span>
          </ConnectionRow>
        ) : null}

        {deposit ? (
          <ConnectionRow icon={PiggyBank} label={tc.deposit}>
            <RecordLink
              type="deposit"
              id={deposit.id}
              label={deposit.reference || formatDate(deposit.date)}
              secondary={formatMoney(deposit.amount, currency)}
            />
          </ConnectionRow>
        ) : null}

        {contact ? (
          <ConnectionRow icon={User} label={tc.contact}>
            <RecordLink type="weldbooks_contact" id={contact.id} label={contact.name ?? tc.contactFallback} />
          </ConnectionRow>
        ) : null}

        {documents.length > 0 ? (
          <ConnectionRow icon={Layers} label={tc.documents}>
            {documents.map((document) => (
              <InboxDocumentChip key={document.id} id={document.id} fileName={document.fileName} />
            ))}
          </ConnectionRow>
        ) : null}
      </div>
    </PanelSection>
  );
}

// ─── Details ───────────────────────────────────────────────────────────────

function Summary({
  links,
  accountName,
  t,
}: Readonly<{ links: BankLineLinks; accountName: string | null; t: Translations }>) {
  const { formatDate } = useWeldbooksFormat();
  const tf = t.accounting.bankTransactionPanel.fields;
  const txn = links.transaction;
  return (
    <div className="space-y-1">
      <PanelRow icon={User} label={tf.counterparty} value={txn.counterpartyName} />
      <PanelRow icon={CalendarDays} label={tf.date} value={formatDate(txn.date)} tabular />
      <PanelRow icon={Building2} label={tf.bankAccount} value={accountName} />
      <PanelRow icon={Banknote} label={tf.reference} value={txn.reference} />
      <PanelRow
        icon={AlignLeft}
        label={tf.description}
        value={txn.description}
        renderValue={(value) => (
          <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-[13px] [overflow-wrap:anywhere]">
            {value}
          </span>
        )}
      />
    </div>
  );
}

function Facts({ links, t }: Readonly<{ links: BankLineLinks; t: Translations }>) {
  const st = useTranslations();
  const tp = t.accounting.bankTransactionPanel;
  const txn = links.transaction;
  const source = txn.source ? (tp.sources[txn.source] ?? txn.source) : null;
  return (
    <PanelSection title={tp.detailsTitle}>
      <div className="space-y-1">
        <PanelRow
          icon={CircleDot}
          label={st('sweep.entities.fieldStatus')}
          value={tp.processedAs[links.processedAs]}
          renderValue={(value) => <span className={cn(PILL, PROCESSED_PILL[links.processedAs])}>{value}</span>}
        />
        <PanelRow
          icon={CreditCard}
          label={tp.fields.counterpartyAccount}
          value={txn.counterpartyIban}
          renderValue={(value) => <span className="font-mono">{value}</span>}
        />
        <PanelRow icon={Layers} label={tp.fields.source} value={source} />
        <PanelRow
          icon={StickyNote}
          label={tp.fields.notes}
          value={txn.notes}
          renderValue={(value) => (
            <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value}</span>
          )}
        />
      </div>
    </PanelSection>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────────────

export function BankTransactionPanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const { can } = usePermissions();
  const router = useRouter();
  const tp = t.accounting.bankTransactionPanel;
  const { entityCurrency } = useWeldbooksFormat();

  const { links, isLoading, isError } = useBankTransactionLinks(id);
  const account = useBankAccount(links?.transaction.bankAccountId).data?.data;
  const currency = account?.currency ?? entityCurrency;

  const unreconcile = useUnreconcileBankLine();
  const exclude = useExcludeBankLine();
  const [confirm, setConfirm] = useState<'undo' | 'ignore' | null>(null);

  const shell = useObjectPanelShell({
    ...props,
    width: BANK_TRANSACTION_PANEL_WIDTH,
    loading: isLoading && !links,
  });
  const mode = shell.mode;

  const tabs = useMemo(
    () => getBankTransactionTabs({ details: st('sweep.entities.detailsTab'), history: st('sweep.entities.auditLogTab') }),
    [st],
  );
  const initial = useMemo<BankTransactionTab['id']>(
    () => tabs.find((tab) => tab.id === initialTab)?.id ?? 'overview',
    [initialTab, tabs],
  );
  const [activeTab, setActiveTab] = useState<BankTransactionTab['id']>(initial);

  const handleMatch = () => {
    if (!links) return;
    const query = new URLSearchParams({ accountId: links.transaction.bankAccountId, lineId: links.transaction.id });
    router.push(withQuery('/weldbooks/banking/reconciliation', query.toString()));
  };

  const runConfirmed = async () => {
    try {
      if (confirm === 'undo') {
        await unreconcile.mutateAsync(id);
        toast.success(tp.toasts.undone);
      } else if (confirm === 'ignore') {
        await exclude.mutateAsync(id);
        toast.success(tp.toasts.ignored);
      }
      setConfirm(null);
    } catch (error) {
      toast.error(tp.toasts.failed, { description: messageOf(error) || undefined });
    }
  };

  const confirmTexts = confirm === 'ignore' ? tp.confirmIgnore : tp.confirmUndo;

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={<Title links={links} currency={currency} t={t} />}
        actions={
          <Actions
            links={links}
            canEdit={can('banking:update')}
            onUndo={() => setConfirm('undo')}
            onIgnore={() => setConfirm('ignore')}
            onMatch={handleMatch}
            t={t}
          />
        }
        tabs={<ConfigurablePanelTabs objectType={OBJECT_TYPE} tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} mode={mode} />}
      >
        {!isLoading && isError && <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>}
        {!isLoading && !isError && !links && (
          <div className="p-6 text-center text-sm text-muted-foreground">{tp.notFound}</div>
        )}

        {links && activeTab === 'overview' && (
          <div className="@container space-y-6 p-4">
            <Summary links={links} accountName={account?.name ?? null} t={t} />
            <Connections links={links} currency={currency} t={t} />
            <Facts links={links} t={t} />
          </div>
        )}
        {links && activeTab === 'history' && <EntityAuditPanel entityType={OBJECT_TYPE} entityId={links.transaction.id} />}
      </EntityDetailView>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirmTexts.title}
        description={confirmTexts.description}
        confirmLabel={confirmTexts.confirm}
        variant={confirm === 'undo' ? 'destructive' : 'default'}
        loading={unreconcile.isPending || exclude.isPending}
        onConfirm={runConfirmed}
      />
    </>
  );
}
