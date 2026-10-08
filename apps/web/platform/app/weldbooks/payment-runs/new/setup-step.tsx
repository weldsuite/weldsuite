import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import type { UsBankAccount } from '@/lib/api/domains/weldbooks-banking';
import {
  ACH_SEC_CODES,
  RUN_METHODS,
  type AchSecCode,
  type BankPaymentSettings,
  type RunMethod,
} from '@/lib/api/domains/weldbooks-payment-runs';
import { MissingSettings } from '../components/missing-settings';
import { defaultApprovals, type RunPlanOptions } from './new-run-model';

export interface SetupValues extends Omit<RunPlanOptions, 'bankAccountId'> {
  bankAccountId: string;
  /** Only bills due on or before this day (YYYY-MM-DD); empty for all. */
  dueBefore: string;
}

interface SetupStepProps {
  values: SetupValues;
  onChange: (patch: Partial<SetupValues>) => void;
  accounts: readonly UsBankAccount[];
  accountsLoading: boolean;
  settings: BankPaymentSettings | undefined;
  settingsLoading: boolean;
  canManage: boolean;
  onNext: () => void;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What the method still needs from the bank account's settings. */
export function methodReadiness(settings: BankPaymentSettings | undefined, method: RunMethod): { ready: boolean; missing: string[] } {
  if (!settings) return { ready: false, missing: [] };
  const readiness = method === 'check' ? settings.readiness.checks : settings.readiness.ach;
  return { ready: readiness.ready, missing: readiness.missing };
}

/** Step 1: the bank account, how to pay, when, and who approves. */
export function SetupStep({
  values,
  onChange,
  accounts,
  accountsLoading,
  settings,
  settingsLoading,
  canManage,
  onNext,
}: Readonly<SetupStepProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tw = tp.wizard;

  const readiness = methodReadiness(settings, values.method);
  // A check run can't be created without a next check number; ACH settings only matter when the file is made.
  const blocked = values.method === 'check' && !!settings && !readiness.ready;
  const dateValid = ISO_DAY.test(values.paymentDate);
  const canContinue = !!values.bankAccountId && dateValid && !blocked && !settingsLoading;
  const sameDayAllowed = settings?.achSettings.sameDayAllowed ?? false;
  const approvalsLocked = values.method === 'ach' && !canManage;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tw.setup.title}</CardTitle>
        <CardDescription>{tw.setup.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="run-bank-account">{tw.setup.bankAccount}</Label>
            <Select value={values.bankAccountId} onValueChange={(value) => onChange({ bankAccountId: value })}>
              <SelectTrigger id="run-bank-account">
                <SelectValue placeholder={accountsLoading ? tp.common.loading : tw.setup.bankAccountPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                    {account.accountNumberLast4 ? ` ····${account.accountNumberLast4}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!accountsLoading && accounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tw.setup.noBankAccounts}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="run-payment-date">{tw.setup.paymentDate}</Label>
            <Input
              id="run-payment-date"
              type="date"
              value={values.paymentDate}
              onChange={(e) => onChange({ paymentDate: e.target.value })}
              aria-invalid={!dateValid}
            />
            {!dateValid ? <p className="text-sm text-destructive">{tw.setup.paymentDateInvalid}</p> : null}
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{tw.setup.method}</legend>
          <RadioGroup
            value={values.method}
            onValueChange={(value) => {
              const method = value as RunMethod;
              onChange({ method, requiredApprovals: defaultApprovals(method) });
            }}
            className="grid gap-3 sm:grid-cols-2"
          >
            {RUN_METHODS.map((method) => (
              <label
                key={method}
                htmlFor={`run-method-${method}`}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary"
              >
                <RadioGroupItem id={`run-method-${method}`} value={method} className="mt-0.5" />
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium">{tp.methods[method]}</span>
                  <span className="block text-xs text-muted-foreground">{tw.setup.methodHints[method]}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>

        {values.method === 'ach' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="run-sec-code">{tw.setup.secCode}</Label>
              <Select value={values.secCode} onValueChange={(value) => onChange({ secCode: value as AchSecCode | 'auto' })}>
                <SelectTrigger id="run-sec-code">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{tp.secCodes.auto}</SelectItem>
                  {ACH_SEC_CODES.map((code) => (
                    <SelectItem key={code} value={code}>{tp.secCodes[code]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start gap-2 pt-6">
              <Checkbox
                id="run-same-day"
                checked={values.sameDay}
                disabled={!sameDayAllowed}
                onCheckedChange={(checked) => onChange({ sameDay: checked === true })}
              />
              <div className="space-y-0.5">
                <Label htmlFor="run-same-day">{tp.sameDay}</Label>
                <p className="text-xs text-muted-foreground">
                  {sameDayAllowed ? tw.setup.sameDayHint : tw.setup.sameDayOff}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="run-approvals">{tw.setup.approvals}</Label>
            <Select
              value={String(values.requiredApprovals)}
              onValueChange={(value) => onChange({ requiredApprovals: value === '2' ? 2 : 1 })}
              disabled={approvalsLocked}
            >
              <SelectTrigger id="run-approvals">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{tw.setup.approvalsOne}</SelectItem>
                <SelectItem value="2">{tw.setup.approvalsTwo}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {values.method === 'ach' ? tw.setup.approvalsHintAch : tw.setup.approvalsHintCheck}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="run-due-before">{tw.setup.dueBefore}</Label>
            <Input
              id="run-due-before"
              type="date"
              value={values.dueBefore}
              onChange={(e) => onChange({ dueBefore: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">{tw.setup.dueBeforeHint}</p>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="run-notes">{tw.setup.notes}</Label>
          <Textarea
            id="run-notes"
            rows={2}
            maxLength={2000}
            value={values.notes}
            onChange={(e) => onChange({ notes: e.target.value })}
          />
        </div>

        {values.bankAccountId && settings && !readiness.ready ? (
          <MissingSettings
            missing={readiness.missing}
            bankAccountId={values.bankAccountId}
            title={values.method === 'check' ? tw.setup.checkNotReady : tw.setup.achNotReady}
            canEdit={canManage}
          />
        ) : null}

        <div className="flex justify-end">
          <Button type="button" onClick={onNext} disabled={!canContinue}>
            {tw.setup.next}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
