/**
 * WeldHR Payroll — Filings: the loonaangifte per period (NL) and the 941, 940,
 * W-2/W-3 and state returns (US). WeldSuite prepares the figures and files;
 * US employers file and pay them themselves, so "Mark as filed" records it.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Download, FileText, MoreHorizontal, RefreshCw, RotateCw, Send } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrPayrollFiling } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { PanelEntityList, type ColumnDef, type GroupConfig } from '@/components/panel-entity-list';
import {
  useDownloadHrPayrollFilingFile,
  useGenerateHrPayrollFiling,
  useHrPayrollEmployers,
  useHrPayrollFilings,
  useRefreshHrPayrollFilingStatus,
  useSubmitHrPayrollFiling,
} from '@/hooks/queries/use-weldhr-payroll-queries';
import { emptyIcon, useHrBreadcrumbs } from '../../components/page-kit';
import { errorMessage, formatDate } from '../../components/shared';
import { FilingSheet } from '../components/filing-sheet';
import { MarkFiledDialog } from '../components/mark-filed-dialog';
import { FilingStatusBadge, InfoLine, PayrollGate } from '../components/payroll-ui';
import { countryCurrency, formatDecimal, periodRange, yearOptions } from '../lib/format';

const ALL = '__all';
const KINDS = ['nl_loonaangifte', 'us_941', 'us_940', 'us_w2', 'us_state_withholding', 'us_state_unemployment'] as const;
const STATUSES = ['open', 'ready', 'submitted', 'accepted', 'rejected', 'filed'] as const;

export default function WeldHrPayrollFilingsPage() {
  return (
    <PayrollGate>
      <FilingsList />
    </PayrollGate>
  );
}

function FilingsList() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.payroll.title'), href: '/weldhr/payroll' }, { label: t('weldhr.payroll.filings.title') });
  const { can } = usePermissions();
  const canManage = can('payroll:manage');

  const [employerId, setEmployerId] = useState(ALL);
  const [year, setYear] = useState(ALL);
  const [kind, setKind] = useState(ALL);
  const [status, setStatus] = useState(ALL);
  const [selected, setSelected] = useState<HrPayrollFiling | null>(null);
  const [markFiled, setMarkFiled] = useState<HrPayrollFiling | null>(null);

  const { data: employers } = useHrPayrollEmployers();
  const { data: filings, isLoading, error } = useHrPayrollFilings({
    employerId: employerId === ALL ? undefined : employerId,
    year: year === ALL ? undefined : Number(year),
    kind: kind === ALL ? undefined : kind,
    status: status === ALL ? undefined : status,
  });

  const generate = useGenerateHrPayrollFiling();
  const submit = useSubmitHrPayrollFiling();
  const refresh = useRefreshHrPayrollFilingStatus();
  const downloadFile = useDownloadHrPayrollFilingFile();

  async function act<T>(action: () => Promise<T>, success: string, failure: string) {
    try {
      await action();
      toast.success(success);
    } catch (err) {
      toast.error(errorMessage(err, failure));
    }
  }

  function kindLabel(filing: HrPayrollFiling): string {
    const base = t(`weldhr.payroll.filingKind.${filing.kind}`);
    return filing.state ? `${base} · ${filing.state}` : base;
  }

  const hasUs = (filings ?? []).some((filing) => filing.country === 'US');

  const groups: GroupConfig<HrPayrollFiling>[] = [
    { id: 'todo', label: t('weldhr.payroll.filings.groups.todo'), sortOrder: 1, filter: (f) => f.status === 'open' || f.status === 'ready' || f.status === 'rejected' },
    { id: 'submitted', label: t('weldhr.payroll.filings.groups.submitted'), sortOrder: 2, filter: (f) => f.status === 'submitted' },
    { id: 'done', label: t('weldhr.payroll.filings.groups.done'), sortOrder: 3, filter: (f) => f.status === 'accepted' || f.status === 'filed' },
  ];

  const columns: ColumnDef<HrPayrollFiling>[] = [
    {
      id: 'kind',
      header: t('weldhr.payroll.filings.table.kind'),
      width: 'flex-1',
      render: (filing) => (
        <span className="block truncate">
          <span className="font-medium">{kindLabel(filing)}</span>
          <span className="text-muted-foreground"> · {filing.employerName}</span>
        </span>
      ),
    },
    {
      id: 'period',
      header: t('weldhr.payroll.common.period'),
      width: 'w-[210px]',
      render: (filing) => <span className="text-muted-foreground">{periodRange(filing.periodStart, filing.periodEnd)}</span>,
    },
    {
      id: 'due',
      header: t('weldhr.payroll.filings.table.dueDate'),
      width: 'w-[110px]',
      render: (filing) => <span className="text-muted-foreground">{formatDate(filing.dueDate)}</span>,
    },
    {
      id: 'amount',
      header: t('weldhr.payroll.filings.table.amountDue'),
      width: 'w-[120px]',
      render: (filing) => <span className="font-medium tabular-nums">{formatDecimal(filing.amountDue, countryCurrency(filing.country))}</span>,
    },
    {
      id: 'reference',
      header: t('weldhr.payroll.filings.paymentReference'),
      width: 'w-[170px]',
      render: (filing) => <span className="block truncate font-mono text-xs text-muted-foreground">{filing.paymentReference ?? '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.payroll.common.status'),
      width: 'w-[110px]',
      render: (filing) => <FilingStatusBadge status={filing.status} />,
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[44px]',
      render: (filing) => {
        const closed = filing.status === 'accepted' || filing.status === 'filed';
        const canDownload = filing.fileName !== null || filing.generatedAt !== null;
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('weldhr.payroll.filings.actions.menu')}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setSelected(filing)}>
                  <FileText className="mr-2 h-4 w-4" />
                  {t('weldhr.payroll.filings.actions.details')}
                </DropdownMenuItem>
                {canManage && !closed && (
                  <DropdownMenuItem
                    onSelect={() => void act(() => generate.mutateAsync(filing.id), t('weldhr.payroll.filings.generated'), t('weldhr.payroll.filings.generateFailed'))}
                  >
                    <RotateCw className="mr-2 h-4 w-4" />
                    {filing.generatedAt ? t('weldhr.payroll.filings.actions.regenerate') : t('weldhr.payroll.filings.actions.generate')}
                  </DropdownMenuItem>
                )}
                {canDownload && (
                  <DropdownMenuItem
                    disabled={downloadFile.isPending}
                    onSelect={() =>
                      downloadFile.mutate(
                        { id: filing.id, fileName: filing.fileName },
                        { onError: (err) => toast.error(errorMessage(err, t('weldhr.payroll.filings.downloadFailed'))) },
                      )
                    }
                  >
                    <Download className="mr-2 h-4 w-4" />
                    {t('weldhr.payroll.filings.actions.download')}
                  </DropdownMenuItem>
                )}
                {canManage && filing.canSubmit && !closed && (
                  <DropdownMenuItem onSelect={() => void act(() => submit.mutateAsync(filing.id), t('weldhr.payroll.filings.submitted'), t('weldhr.payroll.filings.submitFailed'))}>
                    <Send className="mr-2 h-4 w-4" />
                    {t('weldhr.payroll.filings.actions.submit')}
                  </DropdownMenuItem>
                )}
                {canManage && filing.status === 'submitted' && (
                  <DropdownMenuItem onSelect={() => void act(() => refresh.mutateAsync(filing.id), t('weldhr.payroll.filings.refreshed'), t('weldhr.payroll.filings.refreshFailed'))}>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('weldhr.payroll.filings.actions.refresh')}
                  </DropdownMenuItem>
                )}
                {canManage && !closed && (
                  <DropdownMenuItem onSelect={() => setMarkFiled(filing)}>
                    <Check className="mr-2 h-4 w-4" />
                    {t('weldhr.payroll.filings.actions.markFiled')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={employerId} onValueChange={setEmployerId}>
        <SelectTrigger className="h-8 w-[170px]" aria-label={t('weldhr.payroll.common.employer')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('weldhr.payroll.common.allEmployers')}</SelectItem>
          {(employers ?? []).map((employer) => (
            <SelectItem key={employer.id} value={employer.id}>
              {employer.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={year} onValueChange={setYear}>
        <SelectTrigger className="h-8 w-[110px]" aria-label={t('weldhr.payroll.common.year')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('weldhr.payroll.common.allYears')}</SelectItem>
          {yearOptions().map((option) => (
            <SelectItem key={option} value={String(option)}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={kind} onValueChange={setKind}>
        <SelectTrigger className="h-8 w-[190px]" aria-label={t('weldhr.payroll.filings.table.kind')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('weldhr.payroll.filings.allKinds')}</SelectItem>
          {KINDS.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`weldhr.payroll.filingKind.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger className="h-8 w-[140px]" aria-label={t('weldhr.payroll.common.status')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('weldhr.payroll.common.allStatuses')}</SelectItem>
          {STATUSES.map((option) => (
            <SelectItem key={option} value={option}>
              {t(`weldhr.payroll.filingStatus.${option}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hasUs && (
        <div className="border-b px-4 py-2.5">
          <InfoLine>{t('weldhr.payroll.filings.usNote')}</InfoLine>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <PanelEntityList<HrPayrollFiling>
          items={filings ?? []}
          isLoading={isLoading}
          error={error}
          columns={columns}
          groups={groups}
          filters={[]}
          leftActionButtons={filters}
          searchFields={['employerName']}
          onRowClick={setSelected}
          emptyState={{
            icon: emptyIcon(FileText),
            title: t('weldhr.payroll.filings.empty.title'),
            description: t('weldhr.payroll.filings.empty.description'),
          }}
        />
      </div>

      {selected && <FilingSheet filing={filings?.find((filing) => filing.id === selected.id) ?? selected} onClose={() => setSelected(null)} />}
      {markFiled && <MarkFiledDialog filing={markFiled} onClose={() => setMarkFiled(null)} />}
    </div>
  );
}
