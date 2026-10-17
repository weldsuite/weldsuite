/**
 * The header of the recurring invoice panel: title with status, the edit and
 * "more" actions, the generate / pause / resume buttons and the outcome of the
 * last generation.
 */

import { EllipsisVertical, Link as LinkIcon, Pause, Pencil, Play, RefreshCw, Repeat } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PanelAvatar, useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import type { RecurringInvoice } from '@/lib/api/domains/weldbooks';
import type { GeneratedRecurringInvoice } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { SalesTaxErrorNotice } from '@/app/weldbooks/invoices/components/sales-tax-error-notice';
import { RecurringStatusChip } from './recurring-invoice-tab-bodies';

export function RecurringAvatar() {
  return (
    <PanelAvatar icon={Repeat} className="bg-violet-100 text-violet-600 dark:bg-violet-900 dark:text-violet-400" />
  );
}

export function RecurringTitle({ recurring }: Readonly<{ recurring?: RecurringInvoice }>) {
  const { t } = useI18n();
  if (!recurring) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">
        {recurring.name || t.accounting.recurringPage.defaultName}
      </span>
      <span className="flex-shrink-0">
        <RecurringStatusChip status={recurring.status} />
      </span>
    </div>
  );
}

export function RecurringHeaderActions({
  recurring,
  canUpdate,
  onEdit,
}: Readonly<{ recurring?: RecurringInvoice; canUpdate: boolean; onEdit: () => void }>) {
  const { t } = useI18n();
  const st = useTranslations();
  const td = useDocumentTexts();
  const copyLink = useCopyPanelLink('/weldbooks/recurring', 'recurring_invoice', recurring?.id ?? '');
  if (!recurring) return null;
  return (
    <div className="flex items-center gap-0.5">
      {canUpdate ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-7"
          title={td.recurring.editTemplate}
          aria-label={td.recurring.editTemplate}
          onClick={onEdit}
        >
          <Pencil className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={t.accounting.invoiceDetail.moreActions}
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

/** Generate now and pause while the template runs; resume while it is paused. */
export function RecurringActionBar({
  status,
  generating,
  pausing,
  resuming,
  onGenerate,
  onPause,
  onResume,
}: Readonly<{
  status: string;
  generating: boolean;
  pausing: boolean;
  resuming: boolean;
  onGenerate: () => void;
  onPause: () => void;
  onResume: () => void;
}>) {
  const { t } = useI18n();
  const trp = t.accounting.recurringPage;
  if (status !== 'active' && status !== 'paused') return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-1">
      {status === 'active' ? (
        <>
          <Button size="sm" onClick={onGenerate} disabled={generating}>
            <RefreshCw className="h-4 w-4" />
            {generating ? trp.generating : trp.generateNow}
          </Button>
          <Button variant="outline" size="sm" onClick={onPause} disabled={pausing}>
            <Pause className="h-4 w-4" />
            {trp.pause}
          </Button>
        </>
      ) : (
        <Button size="sm" onClick={onResume} disabled={resuming}>
          <Play className="h-4 w-4" />
          {trp.resume}
        </Button>
      )}
    </div>
  );
}

/** What the last "Generate now" did: the new invoice, a sales tax refusal, or an invoice left as a draft. */
export function GenerationResult({
  error,
  generated,
  onOpenInvoice,
}: Readonly<{
  error: unknown;
  generated: GeneratedRecurringInvoice | undefined;
  onOpenInvoice: (invoiceId: string) => void;
}>) {
  const { t } = useI18n();
  const td = useDocumentTexts();
  const trp = t.accounting.recurringPage;
  return (
    <>
      {error ? (
        <div className="px-4 pt-4">
          <SalesTaxErrorNotice error={error} />
        </div>
      ) : null}
      {generated && !generated.finalizeError && (
        <div className="px-4 pt-4 text-sm text-green-600">
          {trp.generatedInvoice.replace('{number}', generated.invoiceNumber ?? '')}
        </div>
      )}
      {generated?.finalizeError && (
        <div className="px-4 pt-4">
          <InfoBanner variant="warning" title={td.recurring.finalizeFailedTitle}>
            <p data-testid="finalize-error">
              {td.recurring.finalizeFailed.replace('{message}', generated.finalizeError)}
            </p>
            <button
              type="button"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => onOpenInvoice(generated.invoiceId)}
            >
              {td.recurring.openInvoice}
            </button>
          </InfoBanner>
        </div>
      )}
    </>
  );
}
