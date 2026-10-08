import { Link } from '@tanstack/react-router';
import { Download, Loader2, MoreHorizontal } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import type {
  Form1099Copy,
  Form1099Filing,
  Form1099FilingLine,
  Form1099LineStatus,
} from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { maskedTin, isVendorTinType } from '@/lib/weldbooks/vendor-tin';
import { boxEntries, boxTag, hasOutputs, isEditableFiling, lineAmounts, sortLines } from '../../../form-1099-model';

const STATUS_VARIANT: Record<Form1099LineStatus, 'success' | 'warning' | 'secondary' | 'outline'> = {
  included: 'success',
  filed: 'success',
  excluded: 'secondary',
  needs_tin: 'warning',
  needs_address: 'warning',
};

interface LinesTableProps {
  filing: Form1099Filing;
  lines: readonly Form1099FilingLine[];
  canUpdate: boolean;
  canFile: boolean;
  /** The line whose copies are being built, to show progress on its menu. */
  busyLineId: string | null;
  onEdit: (line: Form1099FilingLine) => void;
  onCorrect: (line: Form1099FilingLine) => void;
  onDownloadCopies: (line: Form1099FilingLine, copies: readonly Form1099Copy[]) => void;
  onMarkDelivered: (line: Form1099FilingLine, method: 'print' | 'email') => void;
}

const COPY_CHOICES: ReadonlyArray<readonly Form1099Copy[]> = [['B'], ['1'], ['2'], ['C']];

/** The recipients of a filing with their amounts, state details, status and delivery, and what can be done with each. */
export function LinesTable({
  filing,
  lines,
  canUpdate,
  canFile,
  busyLineId,
  onEdit,
  onCorrect,
  onDownloadCopies,
  onMarkDelivered,
}: Readonly<LinesTableProps>) {
  const { t } = useI18n();
  const tl = t.weldbooksUs.form1099.lines;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const editable = isEditableFiling(filing.status);
  const outputs = hasOutputs(filing.status);

  if (lines.length === 0) {
    return (
      <div className="rounded-md border p-8 text-center text-sm text-muted-foreground" data-testid="lines-empty">
        {tl.empty}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tl.colRecipient}</TableHead>
            <TableHead>{tl.colTin}</TableHead>
            <TableHead>{tl.colBoxes}</TableHead>
            <TableHead>{tl.colState}</TableHead>
            <TableHead>{tl.colStatus}</TableHead>
            {outputs ? <TableHead>{tl.colDelivery}</TableHead> : null}
            <TableHead className="text-right">
              <span className="sr-only">{tl.colActions}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortLines(lines).map((line) => {
            const entries = boxEntries(line.boxes);
            const { amount, withheld } = lineAmounts(line);
            const onForm = !line.superseded && (line.status === 'included' || line.status === 'filed');
            const canEditLine = canUpdate && !line.superseded && (editable || (filing.status === 'corrected' && line.pendingCorrection));
            const canCorrect = canFile && line.status === 'filed' && !line.superseded && (filing.status === 'filed' || filing.status === 'corrected');
            const tinType = isVendorTinType(line.recipient?.tinType) ? line.recipient?.tinType : null;
            const busy = busyLineId === line.id;
            const name = line.recipient?.name ?? line.partyName ?? '';
            return (
              <TableRow key={line.id} className={cn(line.superseded && 'text-muted-foreground')} data-testid={`line-${line.id}`}>
                <TableCell className="min-w-44">
                  <Link to="/weldbooks/customers/$id" params={{ id: line.partyId }} className="font-medium hover:underline">
                    {name}
                  </Link>
                  {line.recipient?.businessName ? <p className="text-xs text-muted-foreground">{line.recipient.businessName}</p> : null}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {line.isCorrected ? <Badge variant="warning">{tl.correction}</Badge> : null}
                    {line.superseded ? <Badge variant="outline">{tl.replaced}</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="min-w-32">
                  {line.hasTin || line.recipient?.tinLast4 ? (
                    <span className="font-mono text-xs">{maskedTin(tinType, line.recipient?.tinLast4)}</span>
                  ) : (
                    <span className="text-xs text-amber-600 dark:text-amber-400">{tl.noTin}</span>
                  )}
                </TableCell>
                <TableCell className="min-w-44">
                  {entries.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      <ul className="space-y-0.5 text-sm tabular-nums">
                        {entries.map((entry) => (
                          <li key={entry.code} className="flex justify-between gap-3">
                            <span className="text-xs text-muted-foreground">{boxTag(entry.code)}</span>
                            <span>{formatMoney(entry.amount)}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 flex justify-between gap-3 border-t pt-1 text-xs tabular-nums text-muted-foreground">
                        <span>{tl.total}</span>
                        <span>{formatMoney(amount)}</span>
                      </p>
                      {line.adjustments && line.adjustments.length > 0 ? (
                        <p className="text-xs text-muted-foreground">{tl.adjusted.replace('{n}', String(line.adjustments.length))}</p>
                      ) : null}
                      {withheld > 0 ? <p className="text-xs text-muted-foreground">{tl.withheld.replace('{amount}', formatMoney(withheld))}</p> : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="min-w-32 text-sm">
                  {line.stateCode ? (
                    <>
                      <span>{line.stateCode}</span>
                      {line.stateIncome ? <p className="text-xs tabular-nums text-muted-foreground">{formatMoney(line.stateIncome)}</p> : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {line.stateHint?.needsDirectFiling ? (
                    <Badge variant="warning" className="mt-1">
                      {tl.fileDirect.replace('{state}', line.stateHint.state)}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="min-w-40">
                  <Badge variant={STATUS_VARIANT[line.status]}>{tl.status[line.status]}</Badge>
                  {line.status === 'excluded' && line.excludedReason ? (
                    <p className="mt-1 text-xs text-muted-foreground">{line.excludedReason}</p>
                  ) : null}
                </TableCell>
                {outputs ? (
                  <TableCell className="min-w-32 text-xs">
                    {onForm ? (
                      line.deliveredAt ? (
                        <span>
                          {tl.delivered
                            .replace('{method}', line.deliveryMethod ? tl.methods[line.deliveryMethod] : '')
                            .replace('{date}', formatDate(line.deliveredAt))}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{tl.notDelivered}</span>
                      )
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="text-right">
                  {canEditLine || (outputs && onForm) || canCorrect ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" aria-label={tl.actionsFor.replace('{name}', name)} disabled={busy}>
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <MoreHorizontal className="h-4 w-4" aria-hidden />}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-60">
                        {canEditLine ? <DropdownMenuItem onSelect={() => onEdit(line)}>{tl.edit}</DropdownMenuItem> : null}
                        {canCorrect ? <DropdownMenuItem onSelect={() => onCorrect(line)}>{tl.correct}</DropdownMenuItem> : null}
                        {outputs && onForm ? (
                          <>
                            {canEditLine || canCorrect ? <DropdownMenuSeparator /> : null}
                            <DropdownMenuLabel>{tl.copies}</DropdownMenuLabel>
                            {COPY_CHOICES.map((choice) => (
                              <DropdownMenuItem key={choice.join('-')} onSelect={() => onDownloadCopies(line, choice)}>
                                <Download className="mr-2 h-4 w-4" aria-hidden />
                                {tl.copyNames[choice[0]!]}
                              </DropdownMenuItem>
                            ))}
                            <DropdownMenuItem onSelect={() => onDownloadCopies(line, ['B', '1', '2', 'C'])}>
                              <Download className="mr-2 h-4 w-4" aria-hidden />
                              {tl.allCopies}
                            </DropdownMenuItem>
                            {canUpdate ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel>{tl.markDelivered}</DropdownMenuLabel>
                                <DropdownMenuItem onSelect={() => onMarkDelivered(line, 'print')}>{tl.deliveredPrint}</DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => onMarkDelivered(line, 'email')}>{tl.deliveredEmail}</DropdownMenuItem>
                              </>
                            ) : null}
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
