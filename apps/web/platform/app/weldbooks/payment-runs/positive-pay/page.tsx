import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2 } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import {
  usePaymentSettings,
  usePositivePayFile,
  usePositivePayFormats,
} from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { PositivePayFileResult } from '@/lib/api/domains/weldbooks-payment-runs';
import { MissingSettings } from '../components/missing-settings';
import { IssueList } from '../components/nacha-panel';
import { PaymentRunsFrame } from '../components/payment-runs-frame';
import { isPaymentBankAccount } from '../new/new-run-model';
import { describeRunError, fileIssuesOf } from '../run-errors';

const BANK_DEFAULT = 'bank';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Positive Pay export: the checks written (and voided) on a bank account in a date range, as the bank's file. */
export default function PositivePayPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tpp = tp.positivePay;
  const { can } = usePermissions();
  const { formatMoney, today } = useWeldbooksFormat();
  const canManage = can('banking:manage');

  const [bankAccountId, setBankAccountId] = useState('');
  const [format, setFormat] = useState<string>(BANK_DEFAULT);
  const [from, setFrom] = useState(() => today());
  const [to, setTo] = useState(() => today());
  const [result, setResult] = useState<PositivePayFileResult | null>(null);

  const accountsQuery = useBankAccounts();
  const accounts = useMemo(() => (accountsQuery.data?.data ?? []).filter(isPaymentBankAccount), [accountsQuery.data]);
  const formatsQuery = usePositivePayFormats();
  const settingsQuery = usePaymentSettings(bankAccountId || undefined);
  const file = usePositivePayFile();

  // A single bank account is the obvious choice.
  useEffect(() => {
    const only = accounts.length === 1 ? accounts[0] : undefined;
    if (only && !bankAccountId) setBankAccountId(only.id);
  }, [accounts, bankAccountId]);

  const settings = settingsQuery.data;
  const formats = formatsQuery.data ?? [];
  const activeFormatId = format === BANK_DEFAULT ? (settings?.positivePayFormat ?? '') : format;
  const activeFormat = formats.find((f) => f.id === activeFormatId);
  const datesValid = ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to;
  const ready = settings?.readiness.positivePay;

  const generate = () => {
    setResult(null);
    file.mutate(
      { bankAccountId, from, to, ...(format === BANK_DEFAULT ? {} : { format }) },
      {
        onSuccess: (data) => {
          downloadBlob(new Blob([data.content], { type: 'text/plain;charset=utf-8' }), data.fileName);
          // Only the summary stays: the file holds the account number.
          setResult({ ...data, content: '' });
          file.reset();
          toast.success(tpp.downloaded);
        },
      },
    );
  };

  const issues = fileIssuesOf(file.error);

  return (
    <PaymentRunsFrame title={tpp.title} subtitle={tpp.subtitle}>
      {!canManage ? <p className="text-sm text-muted-foreground">{tp.common.noPermission}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>{tpp.formTitle}</CardTitle>
          <CardDescription>{tpp.formDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="pp-account">{tpp.bankAccount}</Label>
              <Select value={bankAccountId} onValueChange={setBankAccountId}>
                <SelectTrigger id="pp-account">
                  <SelectValue placeholder={accountsQuery.isLoading ? tp.common.loading : tp.wizard.setup.bankAccountPlaceholder} />
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
            </div>

            <div className="space-y-2">
              <Label htmlFor="pp-format">{tpp.format}</Label>
              <Select value={format} onValueChange={setFormat} disabled={!bankAccountId}>
                <SelectTrigger id="pp-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={BANK_DEFAULT}>
                    {tpp.formatDefault.replace('{format}', formats.find((f) => f.id === settings?.positivePayFormat)?.label ?? '')}
                  </SelectItem>
                  {formats.map((f) => (
                    <SelectItem key={f.id} value={f.id}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="pp-from">{tpp.from}</Label>
              <Input id="pp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pp-to">{tpp.to}</Label>
              <Input id="pp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={!datesValid} />
              {!datesValid ? <p className="text-sm text-destructive">{tpp.datesInvalid}</p> : null}
            </div>
          </div>

          <p className="text-sm text-muted-foreground">{tpp.rangeHint}</p>

          {activeFormat?.needsBankSpec ? (
            <Alert>
              <AlertTitle>{tpp.templateTitle}</AlertTitle>
              <AlertDescription>{tpp.templateBody}</AlertDescription>
            </Alert>
          ) : null}

          {bankAccountId && ready && !ready.ready ? (
            <MissingSettings missing={ready.missing} bankAccountId={bankAccountId} title={tpp.notReady} canEdit={canManage} />
          ) : null}

          <Button onClick={generate} disabled={!canManage || !bankAccountId || !datesValid || file.isPending || (!!ready && !ready.ready)}>
            {file.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
            {tpp.generate}
          </Button>

          {file.isError ? (
            <Alert variant="destructive">
              <AlertTitle>{tpp.failed}</AlertTitle>
              <AlertDescription>
                <p>{describeRunError(file.error, tp.errors, tp.errors.generic)}</p>
                <IssueList issues={issues.errors} />
                <IssueList issues={issues.warnings} />
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle>{tpp.resultTitle}</CardTitle>
            <CardDescription className="break-all">{result.fileName}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">{tpp.counts.records}</dt>
                <dd className="font-medium tabular-nums">{result.counts.records}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tpp.counts.issued}</dt>
                <dd className="font-medium tabular-nums">
                  {result.counts.issued} · {formatMoney(result.counts.totalIssued)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{tpp.counts.voided}</dt>
                <dd className="font-medium tabular-nums">
                  {result.counts.voided} · {formatMoney(result.counts.totalVoided)}
                </dd>
              </div>
            </dl>
            {result.warnings.length > 0 ? (
              <Alert>
                <AlertTitle>{tpp.warnings}</AlertTitle>
                <AlertDescription>
                  <IssueList issues={result.warnings} />
                </AlertDescription>
              </Alert>
            ) : null}
            <p className="text-sm text-muted-foreground">{tpp.uploadHint}</p>
          </CardContent>
        </Card>
      ) : null}
    </PaymentRunsFrame>
  );
}
