/**
 * Sales → Unbilled time (edition feature `books-time-billing`): the billable WeldFlow hours not on
 * an invoice yet. Customers with hours on the left; on the right the selected customer's hours by
 * project, each with a checkbox (all ticked), the grouping of the invoice lines, a preview of those
 * lines and their totals, and "Create invoice" or "Add to an existing draft". An hour is invoiced
 * once: the server refuses one that is already on an invoice.
 */

import { useMemo, useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { ArrowLeft, Clock, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { ListDetailLayout } from '@weldsuite/ui/components/list-detail-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SegmentedControl } from '@weldsuite/ui/components/segmented-control';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { isTimeBillingAvailable, useInvoiceFromTime, useUnbilledTime } from '@/hooks/queries/use-weldbooks-time-billing-queries';
import { errorDetails, isWeldbooksRequestError } from '@/lib/api/domains/weldbooks-banking';
import { TIME_GROUPINGS, type TimeGrouping, type UnbilledProject } from '@/lib/api/domains/weldbooks-time-billing';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import {
  entriesOf,
  groupTimeLines,
  hasUnratedEntries,
  lineLocale,
  previewTotals,
} from '@/lib/weldbooks/time-billing';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { CustomerList, DraftPickerDialog, EntriesTable, InvoicePreview, customerKey } from './unbilled-parts';

const routeApi = getRouteApi('/weldbooks/time/unbilled/');

/** An invoice takes at most this many time entries (`POST /invoices/from-time`). */
const MAX_ENTRIES = 500;

export default function UnbilledTimePage() {
  const { t, language } = useI18n();
  const copy = t.weldbooksContactPage.unbilled;
  const { can } = usePermissions();
  const { customerId, projectId } = routeApi.useSearch();
  const { open: openPanel } = useObjectPanel();
  // The new draft opens as a panel over this page, deep-linked with `?stack=`.
  useObjectPanelUrlSync('/weldbooks/time/unbilled');
  const { formatDate } = useWeldbooksFormat();

  // Reading it takes invoices and time, and making an invoice of it takes both too: without them nothing is asked.
  const allowed = can('invoices:create') && can('time:read');
  const query = useUnbilledTime({ projectId }, { enabled: allowed });
  const customers = useMemo(() => query.data ?? [], [query.data]);
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const selected =
    customers.find((customer) => customerKey(customer) === pickedKey) ??
    customers.find((customer) => customer.customer.contactId === customerId) ??
    customers[0] ??
    null;

  // On a phone the list and the hours take turns: the hours show once a customer is picked.
  const [showDetail, setShowDetail] = useState(Boolean(customerId));
  const [grouping, setGrouping] = useState<TimeGrouping>('project');
  // The hours left out: every hour is in until the person unticks it.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [draftOpen, setDraftOpen] = useState(false);
  const make = useInvoiceFromTime(selected?.customer.contactId);

  const entries = useMemo(() => (selected ? entriesOf(selected) : []), [selected]);
  const chosen = useMemo(() => entries.filter((entry) => !unchecked.has(entry.id)), [entries, unchecked]);
  const lines = useMemo(
    () => groupTimeLines(chosen, grouping, lineLocale(language)),
    [chosen, grouping, language],
  );
  const totals = useMemo(() => previewTotals(lines), [lines]);

  if (!isTimeBillingAvailable()) return <EditionUnavailablePage />;

  const select = (key: string) => {
    setPickedKey(key);
    setShowDetail(true);
    setUnchecked(new Set());
  };
  const toggle = (entryId: string) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (!next.delete(entryId)) next.add(entryId);
      return next;
    });
  const toggleProject = (project: UnbilledProject, checked: boolean) =>
    setUnchecked((current) => {
      const next = new Set(current);
      for (const entry of project.entries) {
        if (checked) next.delete(entry.id);
        else next.add(entry.id);
      }
      return next;
    });

  const submit = (invoiceId?: string) => {
    if (!selected || chosen.length === 0) return;
    make.mutate(
      { timeEntryIds: chosen.map((entry) => entry.id), grouping, ...(invoiceId ? { invoiceId } : {}) },
      {
        onSuccess: (invoice) => {
          setDraftOpen(false);
          setUnchecked(new Set());
          toast.success(invoiceId ? copy.appended : copy.created, {
            action: { label: copy.openDraft, onClick: () => openPanel({ type: 'invoice', id: invoice.id }) },
          });
          openPanel({ type: 'invoice', id: invoice.id });
        },
        onError: (error) => {
          setDraftOpen(false);
          const status = isWeldbooksRequestError(error) ? error.status : null;
          if (status === 409 && Array.isArray(errorDetails(error)?.timeEntryIds)) {
            // Invoiced in the meantime: the list was refreshed by the mutation, so the hours are gone from it.
            toast.error(copy.alreadyInvoiced);
            return;
          }
          if (status === 400) {
            toast.error(invoiceId ? copy.badDraft : copy.mixed, {
              description: error instanceof Error ? error.message : undefined,
            });
            return;
          }
          toast.error(copy.createFailed, { description: error instanceof Error ? error.message : undefined });
        },
      },
    );
  };

  const header = (
    <header className="space-y-1 border-b border-border px-4 py-4 sm:px-6">
      <h1 className="text-2xl font-semibold">{copy.title}</h1>
      <p className="text-sm text-muted-foreground">{copy.description}</p>
      {projectId ? (
        <p className="flex flex-wrap items-center gap-2 pt-1 text-sm">
          <span className="text-muted-foreground">{copy.filteredByProject}</span>
          <Link
            href={
              customerId
                ? `/weldbooks/time/unbilled?customerId=${encodeURIComponent(customerId)}`
                : '/weldbooks/time/unbilled'
            }
            className="text-primary underline-offset-2 hover:underline"
          >
            {copy.clearProject}
          </Link>
        </p>
      ) : null}
    </header>
  );

  let body;
  if (!allowed) {
    body = <EmptyState icon={Clock} title={copy.noPermission} className="m-6" />;
  } else if (query.isLoading) {
    body = <PageLoader />;
  } else if (query.isError) {
    body = (
      <div className="p-6">
        <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} />
      </div>
    );
  } else if (customers.length === 0 || !selected) {
    body = <EmptyState icon={Clock} title={copy.empty} description={copy.emptyDescription} className="m-6" />;
  } else {
    const tooMany = chosen.length > MAX_ENTRIES;
    const earliest = entries.map((entry) => entry.date).sort()[0];
    body = (
      <ListDetailLayout
        listWidth={320}
        isDetailSelected={showDetail}
        list={<CustomerList customers={customers} selectedKey={customerKey(selected)} onSelect={select} />}
        detailClassName="overflow-y-auto"
      >
        <div className="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-4">
            <Button type="button" variant="ghost" size="sm" className="-ml-2 md:hidden" onClick={() => setShowDetail(false)}>
              <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
              {copy.customersLabel}
            </Button>
            <div>
              <h2 className="text-lg font-semibold">{selected.customer.name}</h2>
              {earliest ? (
                <p className="text-sm text-muted-foreground">{copy.since.replace('{date}', formatDate(earliest))}</p>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {copy.selectedOf
                .replace('{selected}', String(chosen.length))
                .replace('{total}', String(entries.length))}
            </p>
            <EntriesTable customer={selected} unchecked={unchecked} onToggle={toggle} onToggleProject={toggleProject} />
          </div>

          <aside className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.grouping}</p>
              <SegmentedControl
                ariaLabel={copy.grouping}
                value={grouping}
                onChange={setGrouping}
                options={TIME_GROUPINGS.map((value) => ({ value, label: copy.groupings[value] }))}
              />
            </div>
            <InvoicePreview
              lines={lines}
              totals={totals}
              currency={selected.currency}
              hasUnrated={hasUnratedEntries(chosen)}
            />
            {tooMany ? <p className="text-xs text-destructive">{copy.tooMany}</p> : null}
            <div className="flex flex-col gap-2">
              <Button type="button" disabled={chosen.length === 0 || tooMany || make.isPending} onClick={() => submit()}>
                <Receipt className="mr-1 h-4 w-4" aria-hidden />
                {make.isPending ? copy.creating : copy.createInvoice}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={chosen.length === 0 || tooMany || make.isPending}
                onClick={() => setDraftOpen(true)}
              >
                {copy.addToDraft}
              </Button>
            </div>
          </aside>
        </div>

        <DraftPickerDialog
          open={draftOpen}
          onOpenChange={setDraftOpen}
          contactId={selected.customer.contactId}
          currency={selected.currency}
          pending={make.isPending}
          onPick={(invoiceId) => submit(invoiceId)}
        />
      </ListDetailLayout>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {header}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
