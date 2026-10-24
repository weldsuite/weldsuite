import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import {
  useMoneybirdPushOptions,
  useMoneybirdPushStatus,
  useTriggerMoneybirdPush,
  useUpdateConnector,
  type ConnectorConnection,
  type MoneybirdPushSettings,
  type MoneybirdPushStatus,
  type MoneybirdPushTaxRateOverrides,
  type MoneybirdTaxRateOption,
} from '@/hooks/queries/use-connector-queries';

const NONE_VALUE = '__none__';
const AUTOMATIC_VALUE = '__automatic__';

const EMPTY_SETTINGS: MoneybirdPushSettings = {
  enabled: false,
  sourceConnectionIds: [],
  revenueLedgerAccountId: null,
  financialAccountId: null,
  feeLedgerAccountId: null,
  payoutLedgerAccountId: null,
  taxRateOverrides: { reverseCharge: null, outsideEu: null, exempt: null, noTax: null },
  startDate: null,
};

const RUN_STATUS_CLASSES: Record<string, string> = {
  success: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800',
  error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  running: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300 border-blue-200 dark:border-blue-800',
};

function formatDateTime(value: string | null | undefined, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(language);
}

type Translations = ReturnType<typeof useI18n>['t'];
type ConnectorsTranslations = Translations['weldconnect']['connectors'];
type MoneybirdPushTranslations = ConnectorsTranslations['moneybirdPush'];
type FormatFn = ReturnType<typeof useI18n>['format'];

interface TaxOverrideSelectProps {
  label: string;
  automaticLabel: string;
  taxRates: MoneybirdTaxRateOption[];
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}

function TaxOverrideSelect({
  label,
  automaticLabel,
  taxRates,
  value,
  disabled,
  onChange,
}: Readonly<TaxOverrideSelectProps>) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={value ?? AUTOMATIC_VALUE}
        disabled={disabled}
        onValueChange={(next) => onChange(next === AUTOMATIC_VALUE ? null : next)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTOMATIC_VALUE}>{automaticLabel}</SelectItem>
          {taxRates.map((rate) => (
            <SelectItem key={rate.id} value={rate.id}>
              {rate.name} ({rate.percentage}%)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface PushStatusPanelProps {
  status: MoneybirdPushStatus | undefined;
  tp: MoneybirdPushTranslations;
  health: ConnectorsTranslations['health'];
  language: string;
  format: FormatFn;
  onSendNow: () => void;
  sending: boolean;
  canManage: boolean;
}

function PushStatusPanel({
  status,
  tp,
  health,
  language,
  format,
  onSendNow,
  sending,
  canManage,
}: Readonly<PushStatusPanelProps>) {
  const lastRun = status?.lastRun ?? null;
  const running = lastRun?.status === 'running';
  const lastRunAt = formatDateTime(lastRun?.startedAt, language);

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{tp.statusTitle}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={onSendNow}
          disabled={!status?.enabled || sending || running || !canManage}
        >
          {sending || running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {tp.sendNow}
        </Button>
      </div>
      <div className="text-muted-foreground grid grid-cols-2 gap-2 text-xs">
        <p>{format(tp.pushedInvoices, { count: status?.pushedInvoices ?? 0 })}</p>
        <p>{format(tp.pendingInvoices, { count: status?.pendingInvoices ?? 0 })}</p>
        <p>{format(tp.pushedPayouts, { count: status?.pushedPayouts ?? 0 })}</p>
        <p>{format(tp.pendingPayouts, { count: status?.pendingPayouts ?? 0 })}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{tp.lastRunLabel}:</span>
        {lastRun ? (
          <>
            <Badge variant="outline" className={`text-[11px] ${RUN_STATUS_CLASSES[lastRun.status] ?? ''}`}>
              {health[lastRun.status as keyof typeof health] ?? lastRun.status}
            </Badge>
            {lastRunAt ? <span className="text-muted-foreground">{lastRunAt}</span> : null}
          </>
        ) : (
          <span className="text-muted-foreground">{tp.neverRun}</span>
        )}
      </div>
      {lastRun?.error ? <p className="text-xs text-red-600 dark:text-red-400">{lastRun.error}</p> : null}
      {status && status.failedInvoices > 0 ? (
        <p className="text-xs text-red-600 dark:text-red-400">
          {format(tp.failedInvoices, { count: status.failedInvoices })}
        </p>
      ) : null}
      {lastRun?.errorSamples && lastRun.errorSamples.length > 0 ? (
        <div>
          <p className="text-muted-foreground text-[11px] font-medium">{tp.errorSamplesTitle}</p>
          <ul className="space-y-0.5">
            {lastRun.errorSamples.slice(0, 5).map((sample) => (
              <li
                key={`${sample.externalId}:${sample.message}`}
                className="text-[11px] text-red-600/90 dark:text-red-400/90"
              >
                {sample.externalId !== '-' ? `${sample.externalId}: ` : ''}
                {sample.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

interface SourceConnectionsFieldProps {
  tp: MoneybirdPushTranslations;
  connections: Array<{ id: string; displayName: string | null; externalAccountId: string | null }>;
  selected: string[];
  disabled: boolean;
  onToggle: (id: string, checked: boolean) => void;
}

function SourceConnectionsField({ tp, connections, selected, disabled, onToggle }: Readonly<SourceConnectionsFieldProps>) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">{tp.sourceConnectionsLabel}</p>
      <p className="text-muted-foreground text-xs">{tp.sourceConnectionsHint}</p>
      {connections.length === 0 ? (
        <div className="rounded-md border border-dashed p-3 text-xs">
          <p className="text-muted-foreground">{tp.noStripeConnections}</p>
          <p className="text-muted-foreground mt-1">
            {tp.noStripeConnectionsHint}{' '}
            <Link href="/weldconnect/connectors" className="text-primary underline">
              {tp.connectStripeLink}
            </Link>
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {connections.map((conn) => (
            <label key={conn.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={selected.includes(conn.id)}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle(conn.id, checked === true)}
              />
              {conn.displayName || conn.externalAccountId || conn.id}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface MoneybirdPushSettingsPanelProps {
  connection: ConnectorConnection;
  canManage: boolean;
}

export function MoneybirdPushSettingsPanel({ connection, canManage }: Readonly<MoneybirdPushSettingsPanelProps>) {
  const { t, language, format } = useI18n();
  const tc = t.weldconnect.connectors;
  const tp = tc.moneybirdPush;

  const [draft, setDraft] = useState<MoneybirdPushSettings>(connection.settings?.moneybirdPush ?? EMPTY_SETTINGS);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(connection.settings?.moneybirdPush ?? EMPTY_SETTINGS);
    setDirty(false);
    // Only reset the draft when the underlying connection/settings change, not on every keystroke.
  }, [connection.id, connection.settings?.moneybirdPush]);

  const { data: optionsData, isLoading: optionsLoading, isError: optionsError } = useMoneybirdPushOptions(
    connection.id,
  );
  const options = optionsData?.data;
  const { data: statusData } = useMoneybirdPushStatus(connection.id, { poll: true });
  const status = statusData?.data;
  const update = useUpdateConnector();
  const triggerPush = useTriggerMoneybirdPush();

  const applyPatch = (patch: Partial<MoneybirdPushSettings>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };

  const updateTaxOverride = (key: keyof MoneybirdPushTaxRateOverrides, value: string | null) => {
    setDraft((prev) => ({ ...prev, taxRateOverrides: { ...prev.taxRateOverrides, [key]: value } }));
    setDirty(true);
  };

  const toggleSourceConnection = (id: string, checked: boolean) => {
    setDraft((prev) => {
      const without = prev.sourceConnectionIds.filter((item) => item !== id);
      return { ...prev, sourceConnectionIds: checked ? [...without, id] : without };
    });
    setDirty(true);
  };

  const handleSave = () => {
    if (draft.enabled && !draft.revenueLedgerAccountId) {
      toast.error(tp.revenueLedgerRequired);
      return;
    }
    update.mutate(
      { connectionId: connection.id, settings: { moneybirdPush: draft } },
      {
        onSuccess: () => {
          toast.success(tp.saved);
          setDirty(false);
        },
        onError: () => toast.error(tp.saveFailed),
      },
    );
  };

  const handleSendNow = () => {
    triggerPush.mutate(connection.id, {
      onSuccess: () => toast.success(tp.pushStarted),
      onError: () => toast.error(tp.pushFailed),
    });
  };

  const ledgerAccounts = useMemo(() => {
    const accounts = options?.ledgerAccounts ?? [];
    return [...accounts].sort((a, b) => {
      if (a.accountType === b.accountType) return a.name.localeCompare(b.name);
      if (a.accountType === 'revenue') return -1;
      if (b.accountType === 'revenue') return 1;
      return 0;
    });
  }, [options?.ledgerAccounts]);

  return (
    <div className="mb-6 space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{tp.title}</p>
          <p className="text-muted-foreground text-xs">{tp.description}</p>
        </div>
        <Switch
          checked={draft.enabled}
          disabled={!canManage}
          aria-label={tp.enableLabel}
          onCheckedChange={(checked) => applyPatch({ enabled: checked })}
        />
      </div>

      {optionsError ? <p className="text-destructive text-xs">{tp.optionsFailed}</p> : null}

      {optionsLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        </div>
      ) : (
        <>
          <SourceConnectionsField
            tp={tp}
            connections={options?.stripeConnections ?? []}
            selected={draft.sourceConnectionIds}
            disabled={!canManage}
            onToggle={toggleSourceConnection}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mb-push-revenue-ledger">{tp.revenueLedgerLabel}</Label>
              <Select
                value={draft.revenueLedgerAccountId ?? ''}
                disabled={!canManage}
                onValueChange={(value) => applyPatch({ revenueLedgerAccountId: value || null })}
              >
                <SelectTrigger id="mb-push-revenue-ledger">
                  <SelectValue placeholder={tp.revenueLedgerPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {ledgerAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mb-push-financial-account">{tp.financialAccountLabel}</Label>
              <Select
                value={draft.financialAccountId ?? NONE_VALUE}
                disabled={!canManage}
                onValueChange={(value) => applyPatch({ financialAccountId: value === NONE_VALUE ? null : value })}
              >
                <SelectTrigger id="mb-push-financial-account">
                  <SelectValue placeholder={tp.financialAccountPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>{tp.financialAccountNone}</SelectItem>
                  {(options?.financialAccounts ?? []).map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {draft.financialAccountId ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="mb-push-fee-ledger">{tp.feeLedgerLabel}</Label>
                  <Select
                    value={draft.feeLedgerAccountId ?? ''}
                    disabled={!canManage}
                    onValueChange={(value) => applyPatch({ feeLedgerAccountId: value || null })}
                  >
                    <SelectTrigger id="mb-push-fee-ledger">
                      <SelectValue placeholder={tp.feeLedgerPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {ledgerAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="mb-push-payout-ledger">{tp.payoutLedgerLabel}</Label>
                  <Select
                    value={draft.payoutLedgerAccountId ?? ''}
                    disabled={!canManage}
                    onValueChange={(value) => applyPatch({ payoutLedgerAccountId: value || null })}
                  >
                    <SelectTrigger id="mb-push-payout-ledger">
                      <SelectValue placeholder={tp.payoutLedgerPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {ledgerAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : null}
          </div>

          <p className="text-muted-foreground text-[11px]">{tp.setupHint}</p>

          <div>
            <p className="text-sm font-medium">{tp.taxOverridesTitle}</p>
            <p className="text-muted-foreground text-xs">{tp.taxOverridesDescription}</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <TaxOverrideSelect
                label={tp.reverseChargeLabel}
                automaticLabel={tp.taxAutomatic}
                taxRates={options?.taxRates ?? []}
                value={draft.taxRateOverrides.reverseCharge}
                disabled={!canManage}
                onChange={(value) => updateTaxOverride('reverseCharge', value)}
              />
              <TaxOverrideSelect
                label={tp.outsideEuLabel}
                automaticLabel={tp.taxAutomatic}
                taxRates={options?.taxRates ?? []}
                value={draft.taxRateOverrides.outsideEu}
                disabled={!canManage}
                onChange={(value) => updateTaxOverride('outsideEu', value)}
              />
              <TaxOverrideSelect
                label={tp.exemptLabel}
                automaticLabel={tp.taxAutomatic}
                taxRates={options?.taxRates ?? []}
                value={draft.taxRateOverrides.exempt}
                disabled={!canManage}
                onChange={(value) => updateTaxOverride('exempt', value)}
              />
              <TaxOverrideSelect
                label={tp.noTaxLabel}
                automaticLabel={tp.taxAutomatic}
                taxRates={options?.taxRates ?? []}
                value={draft.taxRateOverrides.noTax}
                disabled={!canManage}
                onChange={(value) => updateTaxOverride('noTax', value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mb-push-start-date">{tp.startDateLabel}</Label>
            <p className="text-muted-foreground text-xs">{tp.startDateDescription}</p>
            <Input
              id="mb-push-start-date"
              type="date"
              disabled={!canManage}
              value={draft.startDate ?? ''}
              onChange={(event) => applyPatch({ startDate: event.target.value || null })}
            />
          </div>

          {canManage ? (
            <Button size="sm" onClick={handleSave} disabled={update.isPending || !dirty}>
              {update.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {tp.save}
            </Button>
          ) : null}
        </>
      )}

      <PushStatusPanel
        status={status}
        tp={tp}
        health={tc.health}
        language={language}
        format={format}
        onSendNow={handleSendNow}
        sending={triggerPush.isPending}
        canManage={canManage}
      />
    </div>
  );
}
