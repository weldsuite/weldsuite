import { useId, useMemo, useState } from 'react';
import { Info, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@weldsuite/ui/components/alert';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useAccountingBankAccounts } from '@/hooks/queries/use-accounting-queries';
import { useMapBankFeedAccounts } from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import {
  BANK_FEED_ACCOUNT_TYPES,
  type BankFeedAccount,
  type BankFeedBankAccountType,
  type BankFeedConnection,
  type BankFeedMapAccountsResult,
} from '@/lib/api/domains/weldbooks-bank-feeds';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { describeFeedError, type FeedErrorMessage } from './describe-error';
import { historyDaysOf, linkableBankAccounts, unmappedAccounts, type FeedBankAccount } from './feed-utils';
import { useFeedTexts } from './feed-texts';
import {
  buildMapAccountsInput,
  initialMappingRows,
  lastImportDay,
  mappingProblems,
  type MappingAction,
  type MappingRow,
  type MappingRows,
} from './mapping';

export interface AccountMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: BankFeedConnection;
  /** Bank account the user came from: offered to the first account without a suggested match. */
  defaultBankAccountId?: string;
  onMapped?: (result: BankFeedMapAccountsResult) => void;
}

/**
 * The step after a link: each account the bank reported is linked to an
 * existing WeldBooks bank account (a match is pre-selected), created as a new
 * one, or skipped. Skipped accounts stay on the connection and can be linked
 * later.
 */
export function AccountMappingDialog({
  open,
  onOpenChange,
  connection,
  defaultBankAccountId,
  onMapped,
}: Readonly<AccountMappingDialogProps>) {
  const { t, format, providerName } = useFeedTexts();
  const bankAccountsQuery = useAccountingBankAccounts();
  const accounts = useMemo(() => unmappedAccounts(connection), [connection]);
  const bank = connection.institutionName ?? t.connection.unknownBank;

  // The form starts from what the bank accounts say (last imports), so wait for them.
  const ready = !bankAccountsQuery.isLoading;
  const bankAccounts = useMemo(
    () => ((bankAccountsQuery.data?.data ?? []) as FeedBankAccount[]),
    [bankAccountsQuery.data],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{format(t.mapping.title, { bank })}</DialogTitle>
          <DialogDescription>{t.mapping.description}</DialogDescription>
        </DialogHeader>

        {!ready ? (
          <div className="space-y-3" aria-busy="true" aria-label={t.mapping.bankAccountsLoading}>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : accounts.length === 0 ? (
          <>
            <p className="text-sm text-muted-foreground">{t.mapping.allLinked}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.connect.cancel}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <MappingForm
            key={`${connection.id}:${accounts.map((a) => a.feedAccountId).join(',')}`}
            connection={connection}
            accounts={accounts}
            bankAccounts={bankAccounts}
            bankAccountsFailed={bankAccountsQuery.isError}
            providerLabel={providerName(connection.provider)}
            defaultBankAccountId={defaultBankAccountId}
            onCancel={() => onOpenChange(false)}
            onMapped={(result) => {
              onMapped?.(result);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MappingForm({
  connection,
  accounts,
  bankAccounts,
  bankAccountsFailed,
  providerLabel,
  defaultBankAccountId,
  onCancel,
  onMapped,
}: Readonly<{
  connection: BankFeedConnection;
  accounts: BankFeedAccount[];
  bankAccounts: FeedBankAccount[];
  bankAccountsFailed: boolean;
  providerLabel: string;
  defaultBankAccountId?: string;
  onCancel: () => void;
  onMapped: (result: BankFeedMapAccountsResult) => void;
}>) {
  const { t, format, plural } = useFeedTexts();
  const { formatDate, today } = useWeldbooksFormat();
  const map = useMapBankFeedAccounts();
  const baseId = useId();

  const linkable = useMemo(
    () => linkableBankAccounts(bankAccounts, connection.id),
    [bankAccounts, connection.id],
  );
  const [rows, setRows] = useState<MappingRows>(() =>
    initialMappingRows(accounts, {
      institutionName: connection.institutionName,
      bankAccounts: linkable,
      defaultBankAccountId,
    }),
  );
  const [startSync, setStartSync] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<FeedErrorMessage | null>(null);

  const problems = useMemo(() => mappingProblems(accounts, rows), [accounts, rows]);
  const input = useMemo(() => buildMapAccountsInput(accounts, rows, { sync: startSync }), [accounts, rows, startSync]);
  const linkCount = input?.mappings.length ?? 0;
  const hasProblems = Object.keys(problems).length > 0;

  const historyDays = historyDaysOf(connection);
  const usedBankAccountIds = new Set<string>();
  for (const account of accounts) {
    const row = rows[account.feedAccountId];
    if (row.action === 'link' && row.bankAccountId) usedBankAccountIds.add(row.bankAccountId);
  }

  const update = (feedAccountId: string, patch: Partial<MappingRow>) => {
    setError(null);
    setRows((current) => ({ ...current, [feedAccountId]: { ...current[feedAccountId], ...patch } }));
  };

  const chooseBankAccount = (feedAccountId: string, bankAccountId: string) => {
    const imported = lastImportDay(linkable.find((a) => a.id === bankAccountId));
    // A different bank account has a different import history: start the feed after it.
    update(feedAccountId, { bankAccountId, syncFrom: imported });
  };

  const submit = () => {
    setSubmitted(true);
    if (!input || hasProblems) return;
    setError(null);
    map.mutate(
      { connectionId: connection.id, input },
      {
        onSuccess: (result) => {
          const done = plural(result.mapped.length, t.mapping.done);
          toast.success(result.syncStarted ? `${done} ${t.connect.syncStarted}` : done);
          onMapped(result);
        },
        onError: (err) => setError(describeFeedError(err, t, 'map')),
      },
    );
  };

  return (
    <>
      <div className="space-y-4">
        <Alert>
          <Info />
          <AlertTitle>{t.mapping.historyTitle}</AlertTitle>
          {historyDays ? (
            <AlertDescription>
              {format(t.mapping.historyBody, { provider: providerLabel, days: historyDays })}
            </AlertDescription>
          ) : null}
        </Alert>

        {bankAccountsFailed ? (
          <Alert variant="destructive">
            <AlertDescription>{t.mapping.bankAccountsError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-3">
          {accounts.map((account, index) => {
            const row = rows[account.feedAccountId];
            const problem = submitted ? problems[account.feedAccountId] : undefined;
            const id = `${baseId}-${index}`;
            const chosenBank = row.action === 'link' ? linkable.find((a) => a.id === row.bankAccountId) : undefined;
            const imported = chosenBank ? lastImportDay(chosenBank) : '';
            const currencyDiffers =
              !!chosenBank?.currency && chosenBank.currency.toUpperCase() !== account.currency.toUpperCase();

            return (
              <div
                key={account.feedAccountId}
                role="group"
                aria-label={account.name}
                className="space-y-3 rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{account.name}</span>
                  {account.mask ? (
                    <span className="text-sm text-muted-foreground">••{account.mask}</span>
                  ) : null}
                  <Badge variant="outline">{t.connection.accountTypes[account.type]}</Badge>
                  <span className="text-sm text-muted-foreground">{account.currency}</span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-action`}>{t.mapping.actionLabel}</Label>
                    <Select
                      value={row.action}
                      onValueChange={(value) => update(account.feedAccountId, { action: value as MappingAction })}
                    >
                      <SelectTrigger id={`${id}-action`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="link">{t.mapping.actionLink}</SelectItem>
                        <SelectItem value="create">{t.mapping.actionCreate}</SelectItem>
                        <SelectItem value="skip">{t.mapping.actionSkip}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {row.action === 'link' ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`${id}-bank`}>{t.mapping.bankAccountLabel}</Label>
                      <Select
                        value={row.bankAccountId}
                        onValueChange={(value) => chooseBankAccount(account.feedAccountId, value)}
                      >
                        <SelectTrigger
                          id={`${id}-bank`}
                          className="w-full"
                          aria-invalid={problem === 'bank_account_required' || problem === 'bank_account_twice'}
                        >
                          <SelectValue placeholder={t.mapping.selectBankAccount} />
                        </SelectTrigger>
                        <SelectContent>
                          {linkable.map((bankAccount) => (
                            <SelectItem
                              key={bankAccount.id}
                              value={bankAccount.id}
                              disabled={
                                usedBankAccountIds.has(bankAccount.id) && bankAccount.id !== row.bankAccountId
                              }
                            >
                              {bankAccount.name}
                              {bankAccount.currency ? ` (${bankAccount.currency})` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {linkable.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t.mapping.noBankAccounts}</p>
                      ) : null}
                      {account.suggestion && account.suggestion.bankAccountId === row.bankAccountId ? (
                        <Badge variant="secondary">{t.mapping.suggested[account.suggestion.reason]}</Badge>
                      ) : null}
                      {currencyDiffers && chosenBank ? (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          {format(t.mapping.currencyMismatch, {
                            feed: account.currency,
                            bank: chosenBank.currency ?? '',
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {row.action === 'create' ? (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${id}-name`}>{t.mapping.newNameLabel}</Label>
                        <Input
                          id={`${id}-name`}
                          value={row.createName}
                          maxLength={255}
                          aria-invalid={problem === 'name_required'}
                          onChange={(e) => update(account.feedAccountId, { createName: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`${id}-type`}>{t.mapping.newTypeLabel}</Label>
                        <Select
                          value={row.createType}
                          onValueChange={(value) =>
                            update(account.feedAccountId, { createType: value as BankFeedBankAccountType })
                          }
                        >
                          <SelectTrigger id={`${id}-type`} className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {BANK_FEED_ACCOUNT_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>
                                {t.mapping.accountTypes[type]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  ) : null}
                </div>

                {problem ? (
                  <p role="alert" className="text-sm text-destructive">
                    {t.mapping.problems[problem]}
                  </p>
                ) : null}

                {row.action !== 'skip' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor={`${id}-from`}>{t.mapping.syncFromLabel}</Label>
                    <Input
                      id={`${id}-from`}
                      type="date"
                      value={row.syncFrom}
                      max={today()}
                      className="sm:w-48"
                      onChange={(e) => update(account.feedAccountId, { syncFrom: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      {historyDays
                        ? format(t.mapping.syncFromHint, { provider: providerLabel, days: historyDays })
                        : t.mapping.syncFromHintNoLimit}
                    </p>
                    {imported ? (
                      <p className="text-xs text-muted-foreground">
                        {format(t.mapping.syncFromImported, { date: formatDate(imported) })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              <span>{error.message}</span>
              {error.detail ? (
                <span className="text-xs">{format(t.errors.detail, { detail: error.detail })}</span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {submitted && !input && !hasProblems ? (
          <p role="alert" className="text-sm text-destructive">
            {t.mapping.nothingToLink}
          </p>
        ) : null}

        <div className="flex items-center gap-2">
          <Checkbox
            id={`${baseId}-sync`}
            checked={startSync}
            onCheckedChange={(checked) => setStartSync(checked === true)}
          />
          <Label htmlFor={`${baseId}-sync`} className="font-normal">
            {t.mapping.startSync}
          </Label>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" disabled={map.isPending} onClick={onCancel}>
          {t.mapping.later}
        </Button>
        <Button type="button" disabled={map.isPending} onClick={submit}>
          {map.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {map.isPending ? t.mapping.linking : plural(Math.max(linkCount, 1), t.mapping.submit)}
        </Button>
      </DialogFooter>
    </>
  );
}
