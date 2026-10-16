/**
 * WeldHR payroll employers: the legal entities that pay salaries (tax numbers,
 * salary account, WeldBooks link). Lives on Settings → Entities, next to the
 * WeldBooks entities. Needs payroll:manage.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Building2, Landmark, MoreHorizontal, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { useDeleteHrPayrollEmployer, useHrPayrollEmployers, useUpdateHrPayrollEmployer } from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmptyText, FieldGrid, SectionCard } from '../../components/page-kit';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { EmployerBankDialog } from './employer-bank-dialog';
import { EmployerDialog } from './employer-dialog';
import { IssueList } from './payroll-ui';

export function PayrollEmployersSection() {
  const t = useTranslations();
  const { data: employers, isLoading, error } = useHrPayrollEmployers();

  const [employerDialog, setEmployerDialog] = useState<{ employer?: HrPayrollEmployer } | null>(null);
  const [bankFor, setBankFor] = useState<HrPayrollEmployer | null>(null);
  const [deleteEmployer, setDeleteEmployer] = useState<HrPayrollEmployer | null>(null);

  const updateEmployer = useUpdateHrPayrollEmployer();
  const removeEmployer = useDeleteHrPayrollEmployer();

  if (isLoading) return <PageLoader fullScreen={false} />;

  const employerList = employers ?? [];

  async function toggleActive(employer: HrPayrollEmployer) {
    try {
      await updateEmployer.mutateAsync({ id: employer.id, isActive: !employer.isActive });
    } catch (err) {
      toast.error(errorMessage(err, t('weldhr.payroll.settings.employers.saveFailed')));
    }
  }

  return (
    <>
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.payroll.settings.loadFailed')) : null} />

      <SectionCard
        title={t('weldhr.payroll.settings.employers.title')}
        action={
          <Button size="sm" onClick={() => setEmployerDialog({})}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t('weldhr.payroll.settings.employers.add')}
          </Button>
        }
      >
        {employerList.length === 0 ? (
          <EmptyText>{t('weldhr.payroll.settings.employers.empty')}</EmptyText>
        ) : (
          <div className="space-y-4">
            {employerList.map((employer) => (
              <EmployerCard
                key={employer.id}
                employer={employer}
                onEdit={() => setEmployerDialog({ employer })}
                onBank={() => setBankFor(employer)}
                onToggleActive={() => void toggleActive(employer)}
                onDelete={() => setDeleteEmployer(employer)}
              />
            ))}
          </div>
        )}
      </SectionCard>

      {employerDialog && <EmployerDialog employer={employerDialog.employer} onClose={() => setEmployerDialog(null)} />}
      {bankFor && <EmployerBankDialog employer={bankFor} onClose={() => setBankFor(null)} />}

      <ConfirmDialog
        open={Boolean(deleteEmployer)}
        onOpenChange={(open) => !open && setDeleteEmployer(null)}
        title={t('weldhr.payroll.settings.employers.deleteTitle')}
        description={t('weldhr.payroll.settings.employers.deleteDescription', { name: deleteEmployer?.name ?? '' })}
        variant="destructive"
        confirmLabel={t('weldhr.common.delete')}
        cancelLabel={t('weldhr.common.cancel')}
        onConfirm={async () => {
          if (!deleteEmployer) return;
          try {
            await removeEmployer.mutateAsync(deleteEmployer.id);
            setDeleteEmployer(null);
          } catch (err) {
            toast.error(errorMessage(err, t('weldhr.payroll.settings.employers.deleteFailed')));
          }
        }}
      />
    </>
  );
}

/** The masked salary account (IBAN for NL, account number for US) and its holder. */
function salaryAccountText(employer: HrPayrollEmployer, noBank: string): string {
  const bank = employer.bank;
  if (!bank) return noBank;
  const account = (employer.country === 'NL' ? bank.ibanMasked : bank.accountNumberMasked) ?? '—';
  return bank.accountHolder ? `${account} · ${bank.accountHolder}` : account;
}

function EmployerCard({
  employer,
  onEdit,
  onBank,
  onToggleActive,
  onDelete,
}: Readonly<{ employer: HrPayrollEmployer; onEdit: () => void; onBank: () => void; onToggleActive: () => void; onDelete: () => void }>) {
  const t = useTranslations();
  const isNl = employer.country === 'NL';
  const salaryAccount = salaryAccountText(employer, t('weldhr.payroll.settings.employers.noBank'));

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Building2 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {employer.name}
              <Badge variant="outline">{t(`weldhr.payroll.country.${employer.country}`)}</Badge>
              {!employer.isActive && <Badge variant="secondary">{t('weldhr.payroll.settings.employers.inactive')}</Badge>}
            </p>
            <p className="truncate text-sm text-muted-foreground">
              {employer.legalName} · {t('weldhr.payroll.settings.employers.employeeCount', { count: employer.employeeCount })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onBank}>
            <Landmark className="mr-1.5 h-4 w-4" />
            {t('weldhr.payroll.settings.employers.salaryAccount')}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="outline" className="h-8 w-8" aria-label={t('weldhr.payroll.settings.employers.menu')}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="mr-2 h-4 w-4" />
                {t('weldhr.common.edit')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onToggleActive}>
                <Power className="mr-2 h-4 w-4" />
                {employer.isActive ? t('weldhr.payroll.settings.employers.deactivate') : t('weldhr.payroll.settings.employers.activate')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 className="mr-2 h-4 w-4" />
                {t('weldhr.common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <FieldGrid
        fields={[
          isNl
            ? { label: t('weldhr.payroll.settings.employers.loonheffingennummer'), value: employer.nlSettings.loonheffingennummer }
            : { label: t('weldhr.payroll.settings.employers.ein'), value: employer.usSettings.ein },
          { label: t('weldhr.payroll.settings.employers.accountingEntity'), value: employer.accountingEntityName ?? t('weldhr.payroll.settings.employers.notLinked') },
          { label: t('weldhr.payroll.settings.employers.salaryAccount'), value: salaryAccount },
          { label: t('weldhr.payroll.settings.employers.fourEyes'), value: employer.requireSeparateApprover ? t('weldhr.common.yes') : t('weldhr.common.no') },
        ]}
      />

      {employer.issues.length > 0 && (
        <div className="space-y-2 rounded-md bg-muted/40 p-3">
          <p className="text-sm font-medium">{t('weldhr.payroll.settings.employers.issues')}</p>
          <IssueList issues={employer.issues} currency={employer.currency} />
        </div>
      )}
    </div>
  );
}
