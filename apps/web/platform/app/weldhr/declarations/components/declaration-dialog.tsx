/** New or edited expense declaration, filed by HR on behalf of an employee. */

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrDeclarationCategory, HrDeclarationListItem } from '@weldsuite/app-api-client/domains/weldhr';
import { HR_DECLARATION_CURRENCIES, hrDeclarationCategorySchema } from '@weldsuite/app-api-client/schemas/weldhr';
import {
  useCreateHrDeclaration,
  useUpdateHrDeclaration,
  useUploadHrDeclarationReceipt,
} from '@/hooks/queries/use-weldhr-queries';
import { EmployeePicker, ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { RECEIPT_ACCEPT, parseAmount, receiptProblem } from './receipt-field';

type Currency = (typeof HR_DECLARATION_CURRENCIES)[number];

function isCurrency(value: string): value is Currency {
  return (HR_DECLARATION_CURRENCIES as readonly string[]).includes(value);
}

export function DeclarationDialog({
  declaration,
  onClose,
}: Readonly<{
  /** Set to edit an existing (pending) declaration; omit to file a new one. */
  declaration?: HrDeclarationListItem;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const createDeclaration = useCreateHrDeclaration();
  const updateDeclaration = useUpdateHrDeclaration();
  const uploadReceipt = useUploadHrDeclarationReceipt();

  const [employeeId, setEmployeeId] = useState<string | null>(declaration?.employeeId ?? null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(declaration?.employeeName ?? null);
  const [expenseDate, setExpenseDate] = useState(declaration?.expenseDate ?? todayIso());
  const [category, setCategory] = useState<HrDeclarationCategory>(declaration?.category ?? 'travel');
  const [amount, setAmount] = useState(declaration ? declaration.amount.toFixed(2) : '');
  const [currency, setCurrency] = useState<Currency>(declaration && isCurrency(declaration.currency) ? declaration.currency : 'EUR');
  const [description, setDescription] = useState(declaration?.description ?? '');
  const [receipt, setReceipt] = useState<File | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const saving = createDeclaration.isPending || updateDeclaration.isPending || uploadReceipt.isPending;
  const canSubmit = Boolean(employeeId && expenseDate && amount.trim() && description.trim()) && !saving;

  function pickReceipt(file: File | null) {
    const problem = file ? receiptProblem(file) : null;
    if (problem) {
      setFailure(t(problem === 'size' ? 'weldhr.declarations.form.receiptTooLarge' : 'weldhr.declarations.form.receiptType'));
      setReceipt(null);
      return;
    }
    setFailure(null);
    setReceipt(file);
  }

  async function submit() {
    if (!employeeId) return;
    const parsedAmount = parseAmount(amount);
    if (parsedAmount === null) {
      setFailure(t('weldhr.declarations.form.amountInvalid'));
      return;
    }
    if (expenseDate > todayIso()) {
      setFailure(t('weldhr.declarations.form.futureDate'));
      return;
    }
    setFailure(null);
    const fields = { expenseDate, category, amount: parsedAmount, currency, description: description.trim() };
    try {
      if (declaration) {
        await updateDeclaration.mutateAsync({ id: declaration.id, ...fields });
        if (receipt) await uploadReceipt.mutateAsync({ id: declaration.id, file: receipt });
      } else {
        const result = await createDeclaration.mutateAsync({ employeeId, ...fields, receipt });
        if (result.receiptFailed) toast.warning(t('weldhr.declarations.form.receiptUploadFailed'));
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.declarations.form.failed')));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{declaration ? t('weldhr.declarations.form.editTitle') : t('weldhr.declarations.form.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <ErrorBanner error={failure} />

          {!declaration && (
            <div className="space-y-1.5">
              <Label>{t('weldhr.declarations.form.employee')}</Label>
              <EmployeePicker
                value={employeeId}
                valueLabel={employeeLabel}
                onChange={(id, label) => {
                  setEmployeeId(id);
                  setEmployeeLabel(label);
                }}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hr-declaration-date">{t('weldhr.declarations.form.date')}</Label>
              <Input id="hr-declaration-date" type="date" max={todayIso()} value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.declarations.form.category')}</Label>
              <Select value={category} onValueChange={(value) => setCategory(hrDeclarationCategorySchema.parse(value))}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {hrDeclarationCategorySchema.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`weldhr.declarations.category.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hr-declaration-amount">{t('weldhr.declarations.form.amount')}</Label>
              <Input
                id="hr-declaration-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('weldhr.declarations.form.currency')}</Label>
              <Select value={currency} onValueChange={(value) => isCurrency(value) && setCurrency(value)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HR_DECLARATION_CURRENCIES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-declaration-description">{t('weldhr.declarations.form.description')}</Label>
            <Textarea
              id="hr-declaration-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('weldhr.declarations.form.descriptionPlaceholder')}
              maxLength={2000}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hr-declaration-receipt">{t('weldhr.declarations.form.receipt')}</Label>
            <Input
              id="hr-declaration-receipt"
              type="file"
              accept={RECEIPT_ACCEPT}
              onChange={(e) => pickReceipt(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">
              {declaration?.hasReceipt && !receipt
                ? t('weldhr.declarations.form.receiptCurrent', { name: declaration.receiptFileName ?? '' })
                : t('weldhr.declarations.form.receiptHint')}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('weldhr.declarations.form.cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {saving && t('weldhr.declarations.form.submitting')}
            {!saving && (declaration ? t('weldhr.declarations.form.save') : t('weldhr.declarations.form.submit'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
