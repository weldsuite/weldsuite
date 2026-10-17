import { useMemo, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlertTriangle, ChevronLeft, ChevronRight, FileDown } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useBookBrApuracao, useBrApuracao, isValidApuracaoPeriod } from '@/hooks/queries/use-weldbooks-br-queries';
import type { BrApuracaoResult } from '@/lib/api/domains/weldbooks-br';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { EcdExportDialog } from './components/ecd-export-dialog';

const NUM = 'text-right tabular-nums';

/** `YYYY-MM` shifted by `delta` months. */
export function shiftPeriod(period: string, delta: number): string {
  const [y, m] = period.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month before `today` (YYYY-MM-DD): the one that is usually worked out. */
export function previousMonth(today: string): string {
  return shiftPeriod(today.slice(0, 7), -1);
}

/**
 * Brazil: the monthly worksheet of what the entity owes (apuração), worked out
 * from its tax ledger. Simples Nacional: the DAS per annex with its split; MEI:
 * the fixed DAS-MEI; Lucro Presumido / Real: ISS, ICMS, IPI, PIS and COFINS
 * (debits, credits, offsets) and, at the end of a quarter, IRPJ and CSLL. Every
 * regime also lists the withholdings to pay over. "Book" records the month as a
 * tax return with its journal entry; nothing is filed with any authority.
 */
export default function BrApuracaoPage() {
  const { t } = useI18n();
  const ta = t.weldbooksBr.apuracao;
  const { today } = useWeldbooksFormat();
  const { features } = useCurrentJurisdiction();
  const [period, setPeriod] = useState(() => previousMonth(today()));
  const [ecdOpen, setEcdOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canFile = useCan('taxes:file');
  const query = useBrApuracao(period);
  const book = useBookBrApuracao();

  const handleBook = () => {
    setConfirmOpen(false);
    book.mutate(period, {
      onSuccess: () => toast.success(ta.booked),
      onError: (err) => toast.error(ta.bookFailed, { description: err instanceof Error ? err.message : undefined }),
    });
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{ta.title}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{ta.description}</p>
        </div>
        {features.spedEcd && (
          <Button type="button" variant="outline" onClick={() => setEcdOpen(true)}>
            <FileDown className="mr-1 h-4 w-4" aria-hidden />
            {ta.exportEcd}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={ta.previousMonth}
            onClick={() => setPeriod(shiftPeriod(period, -1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="space-y-2">
            <Label htmlFor="apuracao-period">{ta.period}</Label>
            <Input
              id="apuracao-period"
              type="month"
              value={period}
              onChange={(e) => {
                if (isValidApuracaoPeriod(e.target.value)) setPeriod(e.target.value);
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={ta.nextMonth}
            onClick={() => setPeriod(shiftPeriod(period, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setPeriod(previousMonth(today()))}>
            {ta.lastMonth}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setPeriod(today().slice(0, 7))}>
            {ta.thisMonth}
          </Button>
        </CardContent>
      </Card>

      {query.isLoading && <PageLoader fullScreen={false} />}

      {query.isError && (
        <Alert variant="destructive" data-testid="apuracao-load-error">
          <AlertTriangle />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{query.error instanceof Error && query.error.message ? query.error.message : ta.loadFailed}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void query.refetch()}>
              {ta.retry}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {query.data && (
        <Worksheet
          sheet={query.data}
          canBook={canFile}
          booking={book.isPending}
          onBook={() => setConfirmOpen(true)}
        />
      )}

      <p className="text-xs text-muted-foreground">{ta.worksheetOnly}</p>

      <EcdExportDialog open={ecdOpen} onOpenChange={setEcdOpen} defaultYear={Number(period.slice(0, 4))} />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={ta.bookConfirmTitle}
        description={ta.bookConfirmDescription.replace('{period}', period)}
        confirmLabel={ta.book}
        cancelLabel={ta.cancel}
        loading={book.isPending}
        onConfirm={handleBook}
      />
    </div>
  );
}

function Worksheet({
  sheet,
  canBook,
  booking,
  onBook,
}: Readonly<{ sheet: BrApuracaoResult; canBook: boolean; booking: boolean; onBook: () => void }>) {
  const { t } = useI18n();
  const ta = t.weldbooksBr.apuracao;
  const { formatMoney: fmt, formatDate } = useWeldbooksFormat();
  const regimes = t.weldbooksBr.entity.regimes as Record<string, string>;
  const isBooked = sheet.status === 'booked';
  const withheld = Object.entries(sheet.withheldByCustomers).filter(([, amount]) => amount > 0);

  // The DAS split per tax, summed over the annexes.
  const splitByTax = useMemo(() => {
    const totals = new Map<string, number>();
    for (const line of sheet.simples?.lines ?? []) {
      for (const [tax, amount] of Object.entries(line.byTax)) totals.set(tax, (totals.get(tax) ?? 0) + (amount ?? 0));
    }
    return [...totals.entries()].filter(([, amount]) => amount > 0);
  }, [sheet.simples]);

  const taxNames = ta.taxes as Record<string, string>;
  const withholdingNames = ta.withholdings as Record<string, string>;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{regimes[sheet.regime] ?? sheet.regime}</Badge>
              <Badge variant={isBooked ? 'default' : 'secondary'} data-testid="apuracao-status">
                {isBooked ? ta.statusBooked : ta.statusOpen}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{ta.totalPayable}</p>
            <p className="text-3xl font-semibold tabular-nums" data-testid="apuracao-total">{fmt(sheet.total)}</p>
          </div>
          <div className="space-y-2 sm:text-right">
            {isBooked ? (
              <p className="text-sm text-muted-foreground">
                {ta.bookedNote}
                {sheet.journalEntryId && (
                  <>
                    {' '}
                    <Link
                      to="/weldbooks/journal/$id"
                      params={{ id: sheet.journalEntryId }}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {ta.viewJournalEntry}
                    </Link>
                  </>
                )}
              </p>
            ) : (
              <Button type="button" onClick={onBook} disabled={!canBook || booking || sheet.total === 0}>
                {booking ? ta.booking : ta.book}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {sheet.warnings.length > 0 && (
        <Alert data-testid="apuracao-warnings">
          <AlertTriangle />
          <AlertDescription>
            <p className="font-medium">{ta.warningsTitle}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {sheet.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {sheet.simples && (
        <Section title={ta.simples.title} description={ta.simples.description.replace('{date}', formatDate(sheet.simples.dueDate))}>
          {(sheet.simples.overLimit || sheet.simples.overSublimit) && (
            <Alert variant="destructive" data-testid="simples-limit">
              <AlertTriangle />
              <AlertDescription>{sheet.simples.overLimit ? ta.simples.overLimit : ta.simples.overSublimit}</AlertDescription>
            </Alert>
          )}
          <dl className="flex flex-wrap gap-x-8 gap-y-1 text-sm">
            <div>
              <dt className="text-muted-foreground">{ta.simples.rbt12}</dt>
              <dd className="tabular-nums">{fmt(sheet.simples.rbt12)}</dd>
            </div>
            {sheet.simples.fatorR !== null && (
              <div>
                <dt className="text-muted-foreground">{ta.simples.fatorR}</dt>
                <dd className="tabular-nums">{(sheet.simples.fatorR * 100).toFixed(2)}%</dd>
              </div>
            )}
          </dl>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ta.simples.anexo}</TableHead>
                <TableHead className={NUM}>{ta.simples.revenue}</TableHead>
                <TableHead className={NUM}>{ta.simples.faixa}</TableHead>
                <TableHead className={NUM}>{ta.simples.nominalRate}</TableHead>
                <TableHead className={NUM}>{ta.simples.effectiveRate}</TableHead>
                <TableHead className={NUM}>{ta.simples.amount}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.simples.lines.map((line) => (
                <TableRow key={line.anexo}>
                  <TableCell>{(t.weldbooksBr.entity.anexos as Record<string, string>)[line.anexo] ?? line.anexo}</TableCell>
                  <TableCell className={NUM}>{fmt(line.revenue)}</TableCell>
                  <TableCell className={NUM}>{line.faixa}</TableCell>
                  <TableCell className={NUM}>{line.nominalRate.toFixed(2)}%</TableCell>
                  <TableCell className={NUM}>{line.effectiveRate.toFixed(2)}%</TableCell>
                  <TableCell className={NUM}>{fmt(line.amount)}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="font-medium">{ta.total}</TableCell>
                <TableCell colSpan={4} />
                <TableCell className={`${NUM} font-medium`}>{fmt(sheet.simples.total)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {splitByTax.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">{ta.simples.split}</p>
              <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
                {splitByTax.map(([tax, amount]) => (
                  <li key={tax} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">{taxNames[tax] ?? tax.toUpperCase()}</span>
                    <span className="tabular-nums">{fmt(amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      {sheet.mei && (
        <Section title={ta.mei.title} description={ta.mei.description.replace('{date}', formatDate(sheet.mei.dueDate))}>
          <Table>
            <TableBody>
              <TableRow>
                <TableCell>{ta.mei.inss}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.mei.inss)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>{taxNames.icms}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.mei.icms)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>{taxNames.iss}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.mei.iss)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">{ta.total}</TableCell>
                <TableCell className={`${NUM} font-medium`}>{fmt(sheet.mei.amount)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Section>
      )}

      {sheet.taxes.length > 0 && (
        <Section title={ta.taxesTitle} description={ta.taxesDescription}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ta.tax}</TableHead>
                <TableHead className={NUM}>{ta.debits}</TableHead>
                <TableHead className={NUM}>{ta.credits}</TableHead>
                <TableHead className={NUM}>{ta.offsets}</TableHead>
                <TableHead className={NUM}>{ta.payable}</TableHead>
                <TableHead className={NUM}>{ta.dueDate}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.taxes.map((line) => (
                <TableRow key={line.code}>
                  <TableCell className="font-medium">{taxNames[line.code] ?? line.code.toUpperCase()}</TableCell>
                  <TableCell className={NUM}>{fmt(line.debits)}</TableCell>
                  <TableCell className={NUM}>{fmt(line.credits)}</TableCell>
                  <TableCell className={NUM}>{fmt(line.offsets)}</TableCell>
                  <TableCell className={NUM}>{fmt(line.payable)}</TableCell>
                  <TableCell className={NUM}>{line.dueDate ? formatDate(line.dueDate) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {sheet.withholdingsToPay.length > 0 && (
        <Section title={ta.withholdingsToPayTitle} description={ta.withholdingsToPayDescription}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{ta.tax}</TableHead>
                <TableHead className={NUM}>{ta.base}</TableHead>
                <TableHead className={NUM}>{ta.amount}</TableHead>
                <TableHead className={NUM}>{ta.dueDate}</TableHead>
                <TableHead className={NUM}>{ta.darfCode}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.withholdingsToPay.map((line) => (
                <TableRow key={line.code}>
                  <TableCell className="font-medium">{withholdingNames[line.code] ?? line.code.toUpperCase()}</TableCell>
                  <TableCell className={NUM}>{fmt(line.base)}</TableCell>
                  <TableCell className={NUM}>{fmt(line.amount)}</TableCell>
                  <TableCell className={NUM}>{formatDate(line.dueDate)}</TableCell>
                  <TableCell className={NUM}>{line.darfCode ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {withheld.length > 0 && (
        <Section title={ta.withheldTitle} description={ta.withheldDescription}>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3" data-testid="withheld-by-customers">
            {withheld.map(([code, amount]) => (
              <li key={code} className="flex justify-between gap-2">
                <span className="text-muted-foreground">{withholdingNames[code] ?? code.toUpperCase()}</span>
                <span className="tabular-nums">{fmt(amount)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {sheet.quarterly && (
        <Section
          title={ta.quarterly.title.replace('{quarter}', String(sheet.quarterly.quarter))}
          description={ta.quarterly.description.replace('{date}', formatDate(sheet.quarterly.dueDate))}
        >
          {sheet.quarterly.lc224Applied && <p className="text-xs text-muted-foreground">{ta.quarterly.lc224}</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead className={NUM}>{ta.base}</TableHead>
                <TableHead className={NUM}>{ta.quarterly.tax}</TableHead>
                <TableHead className={NUM}>{ta.quarterly.offset}</TableHead>
                <TableHead className={NUM}>{ta.payable}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">IRPJ</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.irpjBase)}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.irpj + sheet.quarterly.irpjAdditional)}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.irrfOffset)}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.irpjPayable)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">CSLL</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.csllBase)}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.csll)}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.csllOffset)}</TableCell>
                <TableCell className={NUM}>{fmt(sheet.quarterly.csllPayable)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {sheet.quarterly.irpjAdditional > 0 && (
            <p className="text-xs text-muted-foreground">
              {ta.quarterly.additional.replace('{amount}', fmt(sheet.quarterly.irpjAdditional))}
            </p>
          )}
        </Section>
      )}

      {(sheet.informational.cbs > 0 || sheet.informational.ibs > 0) && (
        <Section title={ta.informational.title} description={ta.informational.description}>
          <ul className="flex gap-8 text-sm">
            <li>
              <span className="text-muted-foreground">CBS </span>
              <span className="tabular-nums">{fmt(sheet.informational.cbs)}</span>
            </li>
            <li>
              <span className="text-muted-foreground">IBS </span>
              <span className="tabular-nums">{fmt(sheet.informational.ibs)}</span>
            </li>
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, description, children }: Readonly<{ title: string; description?: string; children: ReactNode }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4 overflow-x-auto">{children}</CardContent>
    </Card>
  );
}
