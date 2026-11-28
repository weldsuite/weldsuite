/**
 * Quote object panel (WeldBooks, edition feature `books-quotes`).
 *
 * Built on the shell of the invoice and company panels (`useObjectPanelShell`
 * + `EntityDetailView` + tabs). A quote is WeldCRM's `crm_quotes` row seen
 * from the books: its lines and totals, who it is for, when it was sent,
 * viewed and accepted, and the invoices made from it.
 *
 * Tabs: Details · Lines · History. Actions: Send (e-mail dialog), Make
 * invoice, Revoke link; editing opens the quote form.
 */

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EllipsisVertical, Link as LinkIcon, Link2Off, Pencil, Receipt, SendHorizontal } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { SendEmailDialog } from '@/components/accounting/send-email-dialog';
import { useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { EntityAuditPanel } from '@/components/entity-audit-panel';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { useAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { useEmailQuote, useQuote, useRevokeQuoteLink } from '@/hooks/queries/use-weldbooks-sales-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { canEditQuote, canInvoiceQuote } from '@/lib/weldbooks/quote-status';
import { useEntityInvoiceDetails } from '@/lib/weldbooks/use-entity-invoice-details';
import { MakeInvoiceDialog } from './make-invoice-dialog';
import { QuoteDetailsTab, QuoteLinesTab, QuoteTitle } from './quote-parts';
import { getQuoteTabs, type QuoteTabId } from './quote-tabs';

const QUOTE_PANEL_WIDTH = 480;

const TAB_IDS: readonly QuoteTabId[] = ['overview', 'lines', 'history'];

function isTabId(value: string | undefined): value is QuoteTabId {
  return TAB_IDS.includes(value as QuoteTabId);
}

/** The API answered 404: the quote was deleted, or the link is wrong. */
function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

export function QuotePanel(props: Readonly<ObjectPanelComponentProps>) {
  const { id, initialTab } = props;
  const { t } = useI18n();
  const st = useTranslations();
  const copy = t.weldbooksSales.quotes;
  const router = useRouter();
  const canUpdate = useCan('invoices:update');
  const canCreate = useCan('invoices:create');
  const quoteQuery = useQuote(id);
  const quote = quoteQuery.data;
  const contact = useAccountingCustomer(quote?.contactId ?? '').data?.data;
  const entityName = useEntityInvoiceDetails().entity?.name;
  const emailQuote = useEmailQuote();
  const revoke = useRevokeQuoteLink();
  const copyLink = useCopyPanelLink('/weldbooks/quotes', 'quote', id);

  const [sendOpen, setSendOpen] = useState(false);
  const [makeOpen, setMakeOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const shell = useObjectPanelShell({ ...props, width: QUOTE_PANEL_WIDTH, loading: quoteQuery.isLoading && !quote });
  const tabs = useMemo(
    () =>
      getQuoteTabs({
        details: st('sweep.entities.detailsTab'),
        lines: copy.lines,
        history: st('sweep.entities.auditLogTab'),
        linesCount: quote?.lines.length || undefined,
      }),
    [st, copy.lines, quote?.lines.length],
  );
  const [activeTab, setActiveTab] = useState<QuoteTabId>(isTabId(initialTab) ? initialTab : 'overview');

  const showEdit = Boolean(quote) && canUpdate && quote !== undefined && canEditQuote(quote);
  const showSend = Boolean(quote) && canUpdate;
  const showMake = quote !== undefined && canCreate && canInvoiceQuote(quote);
  const hasLink = Boolean(quote?.sentAt);

  const revokeLink = () =>
    revoke.mutate(id, {
      onSuccess: () => {
        toast.success(copy.linkRevoked);
        setRevokeOpen(false);
      },
      onError: (error) => toast.error(copy.revokeFailed, { description: error instanceof Error ? error.message : undefined }),
    });

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(shell.mode)}
        title={<QuoteTitle quote={quote} />}
        actions={
          quote ? (
            <div className="flex items-center gap-0.5">
              {showEdit ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7"
                  title={copy.edit}
                  aria-label={copy.edit}
                  onClick={() => router.push(`/weldbooks/quotes/${id}/edit`)}
                >
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </Button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="size-7 data-[state=open]:bg-accent" aria-label={copy.moreActions}>
                    <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void copyLink()}>
                    <LinkIcon />
                    {st('sweep.entities.copyLink')}
                  </DropdownMenuItem>
                  {canUpdate && hasLink ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setRevokeOpen(true)}>
                        <Link2Off />
                        {copy.revokeLink}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null
        }
        subheader={
          quote && (showSend || showMake) ? (
            <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-1">
              {showSend ? (
                <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
                  <SendHorizontal className="mr-1 h-4 w-4" />
                  {copy.send}
                </Button>
              ) : null}
              {showMake ? (
                <Button variant="outline" size="sm" onClick={() => setMakeOpen(true)}>
                  <Receipt className="mr-1 h-4 w-4" />
                  {copy.makeInvoice}
                </Button>
              ) : null}
            </div>
          ) : null
        }
        tabs={
          quote ? (
            <ConfigurablePanelTabs objectType="quote" tabs={tabs} activeTab={activeTab} setActiveTab={setActiveTab} mode={shell.mode} />
          ) : undefined
        }
      >
        {!quoteQuery.isLoading && quoteQuery.isError && !isNotFound(quoteQuery.error) && (
          <div className="p-4 text-sm text-destructive">{st('sweep.entities.failedToLoad')}</div>
        )}
        {!quoteQuery.isLoading && !quote && (!quoteQuery.isError || isNotFound(quoteQuery.error)) && (
          <div className="p-6 text-center text-sm text-muted-foreground">{copy.notFound}</div>
        )}
        {quote && activeTab === 'overview' ? <QuoteDetailsTab quote={quote} /> : null}
        {quote && activeTab === 'lines' ? <QuoteLinesTab quote={quote} /> : null}
        {quote && activeTab === 'history' ? <EntityAuditPanel entityType="quote" entityId={quote.id} /> : null}
      </EntityDetailView>

      {quote ? (
        <>
          <SendEmailDialog
            kind="quote"
            open={sendOpen}
            onOpenChange={setSendOpen}
            defaultTo={contact?.email}
            entityName={entityName}
            documentNumber={quote.quoteNumber}
            send={async (input) => (await emailQuote.mutateAsync({ id, input })).data.delivery}
          />
          <MakeInvoiceDialog quote={quote} open={makeOpen} onOpenChange={setMakeOpen} />
          <ConfirmDialog
            open={revokeOpen}
            onOpenChange={setRevokeOpen}
            title={copy.revokeTitle}
            description={copy.revokeDescription}
            confirmLabel={copy.revokeLink}
            cancelLabel={copy.keep}
            variant="destructive"
            loading={revoke.isPending}
            onConfirm={revokeLink}
          />
        </>
      ) : null}
    </>
  );
}
