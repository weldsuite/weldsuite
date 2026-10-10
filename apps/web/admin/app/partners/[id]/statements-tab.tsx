'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { PartnerStatementView } from '@weldsuite/app-api-client/schemas/partners';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { getPartnerStatement, previewPartnerStatement, runPartnerStatement, voidPartnerStatement } from '@/actions/partners';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { StatementStatusBadge } from '@/components/partners/badges';
import { StatementView, statementPeriodLabel } from '@/components/partners/statement-view';
import { useSubmit } from '@/components/partners/use-submit';
import { formatDay, formatDecimal } from '@/lib/billing-format';
import { fill } from '@/lib/i18n';
import { canRunStatement, canVoidStatement, isPeriod, previousPeriodOf } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerTabProps } from './partner-detail';

export function StatementsTab({ detail, canWrite, nowIso }: Readonly<PartnerTabProps>) {
  const t = partnersCopy().statements;
  const common = partnersCopy().common;
  const router = useRouter();
  const { submit, isPending } = useSubmit();
  const [period, setPeriod] = useState(() => previousPeriodOf(new Date(nowIso)));
  const [preview, setPreview] = useState<PartnerStatementView | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [viewing, setViewing] = useState<PartnerStatementView | null>(null);
  const [runTarget, setRunTarget] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<PartnerStatementView | null>(null);

  const statements = detail.statements.filter((s) => s.id !== null);

  const onPreview = async () => {
    if (!isPeriod(period)) return void toast.error(`${common.month}: YYYY-MM`);
    setPreviewing(true);
    const result = await previewPartnerStatement(detail.partner.id, period);
    setPreviewing(false);
    if (!result.ok) return void toast.error(result.error);
    setPreview(result.data);
  };

  const onView = async (statement: PartnerStatementView) => {
    if (!statement.id) return;
    const result = await getPartnerStatement(detail.partner.id, statement.id);
    if (!result.ok) return void toast.error(`${t.loadFailed} ${result.error}`);
    setViewing(result.data);
  };

  const onRun = () => {
    if (!runTarget) return;
    const target = runTarget;
    submit((requestId) => runPartnerStatement(detail.partner.id, target, requestId), {
      success: t.ran,
      onSuccess: () => {
        setRunTarget(null);
        setPreview(null);
        router.refresh();
      },
    });
  };

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="space-y-3 px-4">
          <div>
            <h2 className="text-sm font-medium">{t.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
          </div>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.columns.period}</TableHead>
                  <TableHead className="w-32">{t.columns.status}</TableHead>
                  <TableHead className="text-right">{t.columns.resale}</TableHead>
                  <TableHead className="text-right">{t.columns.due}</TableHead>
                  <TableHead className="text-right">{t.columns.margin}</TableHead>
                  <TableHead className="w-32">{t.columns.dueAt}</TableHead>
                  <TableHead className="w-56" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {statements.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                      {t.empty}
                    </TableCell>
                  </TableRow>
                )}
                {statements.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium tabular-nums">{statementPeriodLabel(s)}</TableCell>
                    <TableCell>
                      <StatementStatusBadge status={s.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatDecimal(s.totalResale, s.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDecimal(s.totalDue, s.currency)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatDecimal(s.totalMargin, s.currency)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{s.dueAt ? formatDay(s.dueAt) : '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => onView(s)}>
                          {t.view}
                        </Button>
                        {canWrite && canRunStatement(s.status) && (
                          <Button variant="ghost" size="sm" onClick={() => setRunTarget(statementPeriodLabel(s))}>
                            {t.run}
                          </Button>
                        )}
                        {canWrite && canVoidStatement(s.status) && (
                          <Button variant="ghost" size="sm" onClick={() => setVoidTarget(s)}>
                            {t.void}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="py-4">
        <CardContent className="space-y-4 px-4">
          <div>
            <h2 className="text-sm font-medium">{t.previewTitle}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t.previewHint}</p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <Field label={common.month} htmlFor="statement-period">
                <Input id="statement-period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-09" maxLength={7} className="tabular-nums" />
              </Field>
            </div>
            <Button variant="outline" disabled={previewing} onClick={onPreview}>
              {previewing ? common.working : t.preview}
            </Button>
            {canWrite && (
              <Button disabled={!isPeriod(period)} onClick={() => setRunTarget(period)}>
                {t.run}
              </Button>
            )}
          </div>
          {preview && <StatementView statement={preview} />}
        </CardContent>
      </Card>

      <Dialog open={viewing !== null} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{viewing ? fill(t.detailTitle, { period: statementPeriodLabel(viewing) }) : ''}</DialogTitle>
          </DialogHeader>
          {viewing && <StatementView statement={viewing} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={runTarget !== null}
        onOpenChange={(open) => !open && setRunTarget(null)}
        title={runTarget ? fill(t.runTitle, { period: runTarget }) : ''}
        description={t.runHint}
        confirmLabel={t.runSubmit}
        cancelLabel={common.cancel}
        loading={isPending}
        onConfirm={onRun}
      />

      {voidTarget && (
        <ActionDialog
          destructive
          title={fill(t.voidTitle, { period: statementPeriodLabel(voidTarget) })}
          description={t.voidHint}
          submitLabel={t.voidSubmit}
          onSubmit={(reason, requestId) => voidPartnerStatement(detail.partner.id, voidTarget.id as string, { reason }, requestId)}
          successMessage={t.voided}
          onClose={() => {
            setVoidTarget(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
