/** Employee Payroll tab — the tax elections in force and the history; HR can enter a paper form. */

import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, FilePenLine } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTranslations } from '@weldsuite/i18n/client';
import { stateModule } from '@weldsuite/payroll-domain/us/states';
import type { HrPayrollEmployeeDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { useCreateHrTaxElection, useHrTaxElections } from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmptyText, SectionCard } from '../../components/page-kit';
import { formatDate, formatDateTime } from '../../components/shared';
import { TaxElectionDialog, type TaxElectionTarget } from '../components/tax-election-dialog';
import { electionSummary } from '../lib/election-summary';
import { usePayrollLabels } from '../lib/use-payroll-labels';

export function ElectionsCard({ employeeId, detail, canEdit }: Readonly<{ employeeId: string; detail: HrPayrollEmployeeDetail; canEdit: boolean }>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const [target, setTarget] = useState<TaxElectionTarget | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const create = useCreateHrTaxElection();
  const { data: history } = useHrTaxElections(employeeId, { enabled: showHistory });

  const country = detail.employer?.country;
  const workState = detail.profile?.us.workState ?? null;

  // The forms HR can enter for this employee: Dutch credit; US W-4 and the work state's certificate (when the state has one).
  const targets: TaxElectionTarget[] = [];
  if (country === 'NL') targets.push({ kind: 'nl_loonheffingskorting', state: null });
  if (country === 'US') {
    targets.push({ kind: 'us_w4', state: null });
    if (workState && stateModule(workState)?.certificate) targets.push({ kind: 'us_state_certificate', state: workState });
  }

  const stateOption = (state: string, option: string) => labels.stateOption(state, 'filingStatus', option);

  return (
    <SectionCard
      title={t('weldhr.payroll.elections.title')}
      contentClassName="p-0"
      action={
        canEdit &&
        targets.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <FilePenLine className="mr-1.5 h-4 w-4" />
                {t('weldhr.payroll.elections.enterPaper')}
                <ChevronDown className="ml-1.5 h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {targets.map((option) => (
                <DropdownMenuItem key={`${option.kind}-${option.state ?? ''}`} onSelect={() => setTarget(option)}>
                  {t(`weldhr.payroll.elections.titles.${option.kind}`, { state: option.state ?? '' })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    >
      {detail.currentElections.length === 0 ? (
        <EmptyText>{t('weldhr.payroll.elections.empty')}</EmptyText>
      ) : (
        <ul className="divide-y">
          {detail.currentElections.map((election) => (
            <li key={election.id} className="flex flex-wrap items-start justify-between gap-3 px-6 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t(`weldhr.payroll.elections.titles.${election.kind}`, { state: election.state ?? '' })}</p>
                <p className="text-xs text-muted-foreground">{electionSummary(election, t, stateOption)}</p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <p>{t('weldhr.payroll.elections.inForceFrom', { date: formatDate(election.effectiveFrom) })}</p>
                <p className="flex items-center justify-end gap-1.5">
                  <Badge variant="outline">{t(`weldhr.payroll.elections.sources.${election.source}`)}</Badge>
                  {election.signedAt && <span>{formatDateTime(election.signedAt)}</span>}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t px-6 py-2">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setShowHistory((open) => !open)}>
          {showHistory ? t('weldhr.payroll.elections.hideHistory') : t('weldhr.payroll.elections.showHistory')}
        </Button>
      </div>
      {showHistory && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('weldhr.payroll.elections.form')}</TableHead>
              <TableHead>{t('weldhr.payroll.elections.effectiveFrom')}</TableHead>
              <TableHead>{t('weldhr.payroll.elections.signedBy')}</TableHead>
              <TableHead>{t('weldhr.payroll.elections.source')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(history ?? []).map((election) => (
              <TableRow key={election.id}>
                <TableCell>
                  {t(`weldhr.payroll.elections.titles.${election.kind}`, { state: election.state ?? '' })}
                  <span className="block text-xs text-muted-foreground">{electionSummary(election, t, stateOption)}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(election.effectiveFrom)}</TableCell>
                <TableCell>{election.signatureName ?? '—'}</TableCell>
                <TableCell>{t(`weldhr.payroll.elections.sources.${election.source}`)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {target && (
        <TaxElectionDialog
          target={target}
          mode="hr"
          defaultName={detail.employee.displayName}
          onSubmit={async (election) => {
            await create.mutateAsync({ employeeId, election });
            toast.success(t('weldhr.payroll.elections.recorded'));
            setTarget(null);
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </SectionCard>
  );
}
