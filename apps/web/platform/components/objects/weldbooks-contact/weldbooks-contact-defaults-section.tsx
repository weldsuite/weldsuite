/**
 * The Defaults section of a contact's Details tab (edition feature `books-contact-page`): the
 * expense account and VAT rate a bill of this contact starts with, the payment terms, and whether
 * reminders are paused. Each value saves on its own (`PATCH /accounting-contacts/:id/defaults`,
 * `null` clears it). Pausing reminders is for the selected legal entity only, and the note names it ("For <entity name> only").
 */

import { BellOff, Clock, Percent, WalletCards } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@weldsuite/ui/components/switch';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { SelectPropertyRow } from '@/components/objects/_shared/select-property-row';
import { useAccountingAccounts, useAccountingEntity, useAccountingTaxRates } from '@/hooks/queries/use-accounting-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useContactDefaults, useUpdateContactDefaults } from '@/hooks/queries/use-weldbooks-contact-page-queries';
import type { ContactDefaultsPatch } from '@/lib/api/domains/weldbooks-contact-page';
import { useI18n } from '@/lib/i18n/provider';

export function ContactDefaultsSection({ contactId, canEdit }: Readonly<{ contactId: string; canEdit: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.defaults;
  const defaults = useContactDefaults(contactId);
  const update = useUpdateContactDefaults(contactId);
  const accounts = useAccountingAccounts({ type: 'expense' });
  const taxRates = useAccountingTaxRates();
  // The pause is per legal entity (it follows the request's entity): the note names it.
  const { entityId } = useCurrentAccountingEntity();
  const entityName = useAccountingEntity(entityId).data?.name;

  const save = async (patch: ContactDefaultsPatch) => {
    try {
      await update.mutateAsync(patch);
      toast.success(copy.saved);
    } catch (error) {
      toast.error(copy.saveFailed, { description: error instanceof Error ? error.message : undefined });
    }
  };

  const heading = (
    <div className="mb-1.5 flex min-h-[24px] items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{copy.title}</h3>
    </div>
  );

  if (defaults.isError) {
    return (
      <div className="space-y-1">
        {heading}
        <p className="text-sm text-destructive">{copy.loadFailed}</p>
      </div>
    );
  }
  if (!defaults.data) {
    return (
      <div className="space-y-1" aria-busy="true">
        {heading}
        <div className="h-8 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const value = defaults.data;
  const accountOptions = (accounts.data?.data ?? []).map((account) => ({
    value: account.id,
    label: `${account.code} · ${account.name}`,
  }));
  const taxOptions = (taxRates.data?.data ?? []).map((rate) => ({
    value: rate.id,
    label: `${rate.name} (${Number(rate.rate)}%)`,
  }));
  const readOnlyLabel = (options: Array<{ value: string; label: string }>, id: string | null) =>
    options.find((option) => option.value === id)?.label ?? null;

  return (
    <div className="space-y-1">
      {heading}
      <p className="mb-2 text-[13px] text-muted-foreground">{copy.description}</p>

      {canEdit ? (
        <SelectPropertyRow
          icon={WalletCards}
          label={copy.expenseAccount}
          value={value.defaultExpenseAccountId}
          options={accountOptions}
          placeholder={copy.notSet}
          onChange={(next) => void save({ defaultExpenseAccountId: next })}
        />
      ) : (
        <PropertyRow
          icon={WalletCards}
          label={copy.expenseAccount}
          value={readOnlyLabel(accountOptions, value.defaultExpenseAccountId) ?? ''}
          placeholder={copy.notSet}
          readOnly
        />
      )}

      {canEdit ? (
        <SelectPropertyRow
          icon={Percent}
          label={copy.taxRate}
          value={value.defaultTaxRateId}
          options={taxOptions}
          placeholder={copy.notSet}
          onChange={(next) => void save({ defaultTaxRateId: next })}
        />
      ) : (
        <PropertyRow
          icon={Percent}
          label={copy.taxRate}
          value={readOnlyLabel(taxOptions, value.defaultTaxRateId) ?? ''}
          placeholder={copy.notSet}
          readOnly
        />
      )}

      <PropertyRow
        icon={Clock}
        label={copy.paymentTerms}
        value={value.paymentTermsDays === null ? '' : String(value.paymentTermsDays)}
        renderValue={(text) => <span>{copy.paymentTermsDays.replace('{days}', text ?? '')}</span>}
        placeholder={copy.notSet}
        readOnly={!canEdit}
        onSave={(next) => {
          const text = next?.trim() ?? '';
          if (text === '') return save({ paymentTermsDays: null });
          const days = Number(text);
          if (!Number.isInteger(days) || days < 0) {
            toast.error(copy.saveFailed, { description: copy.invalidDays });
            return undefined;
          }
          return save({ paymentTermsDays: days });
        }}
      />

      <div className="grid min-h-[32px] grid-cols-[120px_minmax(0,1fr)] items-start gap-2 py-1">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <BellOff className="h-4 w-4" aria-hidden="true" />
          <span id={`pause-reminders-${contactId}`}>{copy.pauseReminders}</span>
        </div>
        <div className="flex flex-col gap-1">
          <Switch
            checked={value.remindersPaused}
            disabled={!canEdit || update.isPending}
            onCheckedChange={(checked) => void save({ remindersPaused: checked })}
            aria-labelledby={`pause-reminders-${contactId}`}
            aria-describedby={`pause-reminders-note-${contactId}`}
          />
          <p id={`pause-reminders-note-${contactId}`} className="text-xs text-muted-foreground">
            {entityName ? copy.pauseNoteFor.replace('{entity}', entityName) : copy.pauseNote}
          </p>
        </div>
      </div>
    </div>
  );
}
