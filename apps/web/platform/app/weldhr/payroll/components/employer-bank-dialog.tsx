/**
 * The account salaries are paid from. Write-only: the IBAN and the account
 * number are never shown again, only masked. Leaving one of them blank keeps
 * what is stored; the other fields describe the account and are prefilled.
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { hrPayrollEmployerBankSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useSetHrPayrollEmployerBank } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { SelectField, TextField } from './form-fields';
import { InfoLine } from './payroll-ui';

type Values = z.input<typeof hrPayrollEmployerBankSchema>;
type Parsed = z.output<typeof hrPayrollEmployerBankSchema>;

export function EmployerBankDialog({ employer, onClose }: Readonly<{ employer: HrPayrollEmployer; onClose: () => void }>) {
  const t = useTranslations();
  const setBank = useSetHrPayrollEmployerBank();
  const bank = employer.bank;
  const isNl = employer.country === 'NL';

  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(hrPayrollEmployerBankSchema),
    defaultValues: {
      accountHolder: bank?.accountHolder ?? employer.legalName,
      iban: null,
      bic: bank?.bic ?? null,
      routingNumber: bank?.routingNumber ?? null,
      accountNumber: null,
      accountType: bank?.accountType ?? null,
      nachaCompanyId: bank?.nachaCompanyId ?? null,
      bankName: bank?.bankName ?? null,
    },
  });
  const failure = form.formState.errors.root?.message ?? null;

  async function onSubmit(values: Parsed) {
    // A blank secret keeps the stored one (undefined); other blank fields clear (null).
    const keepIban = !values.iban && Boolean(bank?.ibanMasked);
    const keepAccountNumber = !values.accountNumber && Boolean(bank?.accountNumberMasked);
    try {
      await setBank.mutateAsync({
        id: employer.id,
        accountHolder: values.accountHolder ?? null,
        iban: keepIban ? undefined : (values.iban ?? null),
        bic: values.bic ?? null,
        routingNumber: values.routingNumber ?? null,
        accountNumber: keepAccountNumber ? undefined : (values.accountNumber ?? null),
        accountType: values.accountType ?? null,
        nachaCompanyId: values.nachaCompanyId ?? null,
        bankName: values.bankName ?? null,
      });
      toast.success(t('weldhr.payroll.settings.bank.saved'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.settings.bank.saveFailed')) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !setBank.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('weldhr.payroll.settings.bank.title', { employer: employer.name })}</DialogTitle>
          <DialogDescription>{isNl ? t('weldhr.payroll.settings.bank.descriptionNl') : t('weldhr.payroll.settings.bank.descriptionUs')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />

            {bank && (
              <InfoLine>
                {t('weldhr.payroll.settings.bank.current', { account: (isNl ? bank.ibanMasked : bank.accountNumberMasked) ?? '—' })}
              </InfoLine>
            )}

            <TextField control={form.control} name="accountHolder" label={t('weldhr.payroll.settings.bank.accountHolder')} maxLength={140} />

            {isNl ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  control={form.control}
                  name="iban"
                  label="IBAN"
                  placeholder={bank?.ibanMasked ?? 'NL91 ABNA 0417 1643 00'}
                  description={bank?.ibanMasked ? t('weldhr.payroll.settings.bank.keepHint') : undefined}
                  maxLength={34}
                />
                <TextField control={form.control} name="bic" label="BIC" maxLength={11} />
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField control={form.control} name="routingNumber" label={t('weldhr.payroll.settings.bank.routingNumber')} inputMode="numeric" maxLength={9} />
                  <TextField
                    control={form.control}
                    name="accountNumber"
                    label={t('weldhr.payroll.settings.bank.accountNumber')}
                    inputMode="numeric"
                    placeholder={bank?.accountNumberMasked ?? undefined}
                    description={bank?.accountNumberMasked ? t('weldhr.payroll.settings.bank.keepHint') : undefined}
                    maxLength={17}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SelectField
                    control={form.control}
                    name="accountType"
                    label={t('weldhr.payroll.settings.bank.accountType')}
                    options={[
                      { value: 'checking', label: t('weldhr.payroll.settings.bank.checking') },
                      { value: 'savings', label: t('weldhr.payroll.settings.bank.savings') },
                    ]}
                  />
                  <TextField control={form.control} name="bankName" label={t('weldhr.payroll.settings.bank.bankName')} maxLength={23} />
                </div>
                <TextField
                  control={form.control}
                  name="nachaCompanyId"
                  label={t('weldhr.payroll.settings.bank.nachaCompanyId')}
                  description={t('weldhr.payroll.settings.bank.nachaCompanyIdHint')}
                  maxLength={10}
                />
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={setBank.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={setBank.isPending}>
                {setBank.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
