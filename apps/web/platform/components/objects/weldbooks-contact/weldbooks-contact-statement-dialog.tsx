/**
 * "Send statement" on the contact page (edition feature `books-contact-page`): a preview of what
 * the contact still has to pay as of a date (`/accounting-contacts/:id/statement?format=json`), and
 * the PDF to download. The statement cannot be e-mailed from here: no endpoint sends one, and the
 * invoice e-mail route is for an invoice. The dialog says so rather than offering a button that
 * does nothing.
 */

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useContactStatement } from '@/hooks/queries/use-weldbooks-contact-page-queries';
import { contactPageApi } from '@/lib/api/domains/weldbooks-contact-page';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

function StatementPreview({ statement }: Readonly<{ statement: ReturnType<typeof useContactStatement> }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.statement;
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const data = statement.data;
  const kinds = copy.kinds as Record<string, string>;

  if (statement.isLoading) return <InlineSpinner className="py-6" />;
  if (statement.isError || !data) return <ErrorState message={copy.loadFailed} onRetry={() => void statement.refetch()} />;
  if (data.rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{copy.empty}</p>;
  return (
    <div
      role="region"
      aria-label={copy.caption}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="max-h-72 overflow-auto rounded-md border border-border"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{copy.caption}</caption>
        <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              {copy.number}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {copy.date}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {copy.due}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {copy.balance}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={`${row.objectType}:${row.objectId}`} className="border-t border-border">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {row.number ?? kinds[row.kind] ?? row.kind}
                <span className="block text-xs font-normal text-muted-foreground">
                  {kinds[row.kind] ?? row.kind}
                  {row.overdueDays > 0 ? ` · ${row.overdueDays} ${copy.overdueDays.toLowerCase()}` : ''}
                </span>
              </th>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDate(row.date)}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDate(row.dueDate)}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                {formatMoney(row.balance, row.currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {data.totals.map((total) => (
            <tr key={total.currency} className="border-t border-border bg-muted/40">
              <th scope="row" colSpan={3} className="px-3 py-2 text-left font-semibold">
                {copy.total}
              </th>
              <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">
                {formatMoney(total.amount, total.currency)}
              </td>
            </tr>
          ))}
        </tfoot>
      </table>
    </div>
  );
}

function StatementBody({
  contactId,
  contactName,
  onClose,
}: Readonly<{ contactId: string; contactName: string; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.statement;
  const { today } = useWeldbooksFormat();
  const [asOf, setAsOf] = useState(() => today());
  const inputId = useId();
  const [downloading, setDownloading] = useState(false);
  const statement = useContactStatement(contactId, asOf);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const file = await contactPageApi.statementPdf(contactId, asOf || undefined);
      downloadBlob(file.blob, file.filename ?? `statement-${asOf}.pdf`);
      toast.success(copy.downloaded);
    } catch (error) {
      toast.error(copy.downloadFailed, { description: error instanceof Error ? error.message : undefined });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description.replace('{name}', contactName)}</DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{copy.asOf}</Label>
        <Input
          id={inputId}
          type="date"
          value={asOf}
          onChange={(event) => setAsOf(event.target.value)}
          className="w-44"
        />
      </div>

      <section aria-label={copy.preview} className="min-h-24">
        <StatementPreview statement={statement} />
      </section>

      <InfoBanner>{copy.emailNote}</InfoBanner>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {copy.close}
        </Button>
        <Button type="button" onClick={() => void downloadPdf()} disabled={downloading}>
          <Download className="mr-1 h-4 w-4" aria-hidden="true" />
          {downloading ? copy.downloading : copy.downloadPdf}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ContactStatementDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; contactId: string; contactName: string }>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {open ? (
          <StatementBody contactId={contactId} contactName={contactName} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
