import { useMemo } from 'react';
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
import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { fiscalYearContaining, type FiscalYearConfig } from '@/lib/weldbooks/fiscal-year';
import { formatWeldbooksDate, localToday, weldbooksDateLocale } from '@/lib/weldbooks/format';
import {
  classificationsOf,
  defaultUsTimeZone,
  formatEinInput,
  timeZoneOptions,
  validClassification,
  type UsEntityTypeSummary,
} from '@/lib/weldbooks/us-entity';
import { SsnField } from './ssn-field';
import { TIME_ZONE_AUTO, weekFiscalYearConfig, type UsEntityValues } from './us-entity-form';

export type UsEntityFieldErrors = Partial<Record<keyof UsEntityValues, string>>;

/** The first message of every nested US field error of the form state. */
export function usFieldErrors(errors: unknown): UsEntityFieldErrors {
  const out: UsEntityFieldErrors = {};
  if (!errors || typeof errors !== 'object') return out;
  for (const [key, value] of Object.entries(errors)) {
    const message = (value as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string') out[key as keyof UsEntityValues] = message;
  }
  return out;
}

const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

interface UsEntityCardsProps {
  value: UsEntityValues;
  onChange: (next: UsEntityValues) => void;
  errors?: UsEntityFieldErrors;
  entityTypes: readonly UsEntityTypeSummary[];
  disabled?: boolean;
  /** Prefix of the field ids, so the form can share a page with other forms. */
  idPrefix: string;
  /** Editing: the entity whose stored SSN the form shows. Absent while creating. */
  entity?: Pick<AccountingEntity, 'id' | 'hasSsn' | 'ssnLast4' | 'entityType'>;
  /** The address state, for the automatic time zone. */
  state?: string | null;
  /** The member holds `tax_ids:reveal`. */
  canRevealTaxIds?: boolean;
}

/**
 * The US-specific cards of the entity form: legal form and tax classification,
 * tax identifiers (EIN, SSN, state ID) and the accounting setup (method,
 * fiscal year, time zone). One nested form value, edited as a whole.
 */
export function UsEntityCards({
  value,
  onChange,
  errors = {},
  entityTypes,
  disabled,
  idPrefix,
  entity,
  state,
  canRevealTaxIds = false,
}: Readonly<UsEntityCardsProps>) {
  const { t, language } = useI18n();
  const ts = t.weldbooksUs.setup;
  const te = ts.entity;
  const update = (patch: Partial<UsEntityValues>) => onChange({ ...value, ...patch });
  const id = (field: string) => `${idPrefix}-${field}`;

  const typeLabel = (type: string, fallback: string) =>
    (ts.entityTypes as Record<string, string>)[type] ?? fallback;
  const classificationLabel = (classification: string) =>
    (ts.classifications as Record<string, string>)[classification] ?? classification;

  const classifications = classificationsOf(entityTypes, value.entityType);
  const selectedClassification = classifications.find((c) => c.value === value.taxClassification);
  const typeHelp = (ts.entityTypeHelp as Record<string, string>)[value.entityType];
  const legacyType = entity?.entityType && !value.entityType ? entity.entityType : null;

  // Radix Select also reports "" when its value and its options change in the same render (the
  // classifications of a newly chosen type). Nobody can choose "", so those reports are dropped.
  const onTypeChange = (entityType: string) => {
    if (!entityType) return;
    update({ entityType, taxClassification: validClassification(entityTypes, entityType, value.taxClassification) });
  };

  const months = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(language || 'en', { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => ({
      value: String(i + 1),
      label: fmt.format(new Date(Date.UTC(2026, i, 1))),
    }));
  }, [language]);

  const { fiscalYearKind, fiscalYearStart, fiscalEndMonth, fiscalWeekday, fiscalRule } = value;
  const preview = useMemo(() => {
    const config: FiscalYearConfig =
      fiscalYearKind === 'weeks'
        ? weekFiscalYearConfig({ fiscalEndMonth, fiscalWeekday, fiscalRule })
        : { type: 'month', startMonth: Number(fiscalYearStart) || 1 };
    const year = fiscalYearContaining(config, localToday());
    const locale = weldbooksDateLocale(language, 'en-US');
    return {
      start: formatWeldbooksDate(year.start, { locale }),
      end: formatWeldbooksDate(year.end, { locale }),
      weeks: year.weeks,
    };
  }, [language, fiscalYearKind, fiscalYearStart, fiscalEndMonth, fiscalWeekday, fiscalRule]);

  const zoneLabel = (zone: string) => (ts.timeZones as Record<string, string>)[zone] ?? zone;
  const zones = timeZoneOptions(value.timezone !== TIME_ZONE_AUTO ? value.timezone : null);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{te.legalFormTitle}</CardTitle>
          <CardDescription>{te.legalFormDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id('entityType')}>{te.entityType}</Label>
            <Select value={value.entityType} onValueChange={onTypeChange} disabled={disabled}>
              <SelectTrigger id={id('entityType')} aria-invalid={errors.entityType ? true : undefined}>
                <SelectValue placeholder={te.selectEntityType} />
              </SelectTrigger>
              <SelectContent>
                {entityTypes.map((type) => (
                  <SelectItem key={type.type} value={type.type}>
                    {typeLabel(type.type, type.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {typeHelp ? <p className="text-xs text-muted-foreground">{typeHelp}</p> : null}
            {legacyType ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">{te.legacyType.replace('{type}', legacyType)}</p>
            ) : null}
            {errors.entityType ? <p className="text-sm text-destructive">{errors.entityType}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor={id('taxClassification')}>{te.taxClassification}</Label>
            <Select
              value={value.taxClassification}
              onValueChange={(taxClassification) => {
                if (taxClassification) update({ taxClassification });
              }}
              disabled={disabled || classifications.length <= 1}
            >
              <SelectTrigger id={id('taxClassification')} aria-invalid={errors.taxClassification ? true : undefined}>
                <SelectValue placeholder={te.selectClassification} />
              </SelectTrigger>
              <SelectContent>
                {classifications.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {te.classificationOption
                      .replace('{classification}', classificationLabel(c.value))
                      .replace('{form}', c.formLabel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {selectedClassification
                ? te.filesForm.replace('{form}', selectedClassification.formLabel)
                : te.classificationHelp}
            </p>
            {errors.taxClassification ? <p className="text-sm text-destructive">{errors.taxClassification}</p> : null}
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor={id('dba')}>{te.dba}</Label>
            <Input
              id={id('dba')}
              value={value.dba}
              disabled={disabled}
              aria-describedby={id('dba-help')}
              onChange={(e) => update({ dba: e.target.value })}
            />
            <p id={id('dba-help')} className="text-xs text-muted-foreground">{te.dbaHelp}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{te.taxIdsTitle}</CardTitle>
          <CardDescription>{te.taxIdsDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id('ein')}>{te.ein}</Label>
            <Input
              id={id('ein')}
              value={value.ein}
              placeholder={te.einPlaceholder}
              inputMode="numeric"
              autoComplete="off"
              disabled={disabled}
              aria-invalid={errors.ein ? true : undefined}
              aria-describedby={id('ein-help')}
              onChange={(e) => update({ ein: formatEinInput(e.target.value) })}
            />
            <p id={id('ein-help')} className="text-xs text-muted-foreground">{te.einHelp}</p>
            {errors.ein ? <p className="text-sm text-destructive">{errors.ein}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor={id('stateTaxId')}>{te.stateTaxId}</Label>
            <Input
              id={id('stateTaxId')}
              value={value.stateTaxId}
              autoComplete="off"
              disabled={disabled}
              aria-describedby={id('stateTaxId-help')}
              onChange={(e) => update({ stateTaxId: e.target.value })}
            />
            <p id={id('stateTaxId-help')} className="text-xs text-muted-foreground">{te.stateTaxIdHelp}</p>
          </div>

          <div className="sm:col-span-2">
            <SsnField
              id={id('ssn')}
              entityId={entity?.id}
              hasSsn={entity?.hasSsn ?? false}
              last4={entity?.ssnLast4 ?? null}
              value={value.ssn}
              clearSsn={value.clearSsn}
              error={errors.ssn}
              disabled={disabled}
              canReveal={canRevealTaxIds}
              onChange={(patch) => update(patch)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{te.accountingTitle}</CardTitle>
          <CardDescription>{te.accountingDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={id('accountingMethod')}>{te.accountingMethod}</Label>
            <Select
              value={value.accountingMethod}
              onValueChange={(accountingMethod) => update({ accountingMethod: accountingMethod === 'cash' ? 'cash' : 'accrual' })}
              disabled={disabled}
            >
              <SelectTrigger id={id('accountingMethod')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="accrual">{te.accrual}</SelectItem>
                <SelectItem value="cash">{te.cash}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{te.accountingMethodHelp}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={id('timezone')}>{te.timeZone}</Label>
            <Select value={value.timezone} onValueChange={(timezone) => update({ timezone })} disabled={disabled}>
              <SelectTrigger id={id('timezone')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value={TIME_ZONE_AUTO}>
                  {te.timeZoneAuto.replace('{zone}', zoneLabel(defaultUsTimeZone(state)))}
                </SelectItem>
                {zones.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zoneLabel(zone)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{te.timeZoneHelp}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={id('fiscalYearKind')}>{te.fiscalYear}</Label>
            <Select
              value={value.fiscalYearKind}
              onValueChange={(kind) => update({ fiscalYearKind: kind === 'weeks' ? 'weeks' : 'month' })}
              disabled={disabled}
            >
              <SelectTrigger id={id('fiscalYearKind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="month">{te.fiscalYearMonths}</SelectItem>
                <SelectItem value="weeks">{te.fiscalYearWeeks}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {value.fiscalYearKind === 'month' ? (
            <div className="space-y-2">
              <Label htmlFor={id('fiscalYearStart')}>{te.fiscalYearStart}</Label>
              <Select
                value={value.fiscalYearStart}
                onValueChange={(fiscalYearStart) => update({ fiscalYearStart })}
                disabled={disabled}
              >
                <SelectTrigger id={id('fiscalYearStart')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {months.map((month) => (
                    <SelectItem key={month.value} value={month.value}>
                      {month.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor={id('fiscalEndMonth')}>{te.fiscalYearEndMonth}</Label>
                <Select
                  value={value.fiscalEndMonth}
                  onValueChange={(fiscalEndMonth) => update({ fiscalEndMonth })}
                  disabled={disabled}
                >
                  <SelectTrigger id={id('fiscalEndMonth')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((month) => (
                      <SelectItem key={month.value} value={month.value}>
                        {month.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={id('fiscalWeekday')}>{te.fiscalYearWeekday}</Label>
                <Select
                  value={value.fiscalWeekday}
                  onValueChange={(fiscalWeekday) => update({ fiscalWeekday })}
                  disabled={disabled}
                >
                  <SelectTrigger id={id('fiscalWeekday')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAY_KEYS.map((key, index) => (
                      <SelectItem key={key} value={String(index)}>
                        {ts.weekdays[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={id('fiscalRule')}>{te.fiscalYearRule}</Label>
                <Select
                  value={value.fiscalRule}
                  onValueChange={(rule) => update({ fiscalRule: rule === 'nearest' ? 'nearest' : 'last' })}
                  disabled={disabled}
                >
                  <SelectTrigger id={id('fiscalRule')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="last">{te.ruleLast}</SelectItem>
                    <SelectItem value="nearest">{te.ruleNearest}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <p className="text-sm text-muted-foreground sm:col-span-2" data-testid="fiscal-year-preview">
            {(preview.weeks ? te.fiscalYearPreviewWeeks : te.fiscalYearPreview)
              .replace('{start}', preview.start)
              .replace('{end}', preview.end)
              .replace('{weeks}', String(preview.weeks ?? ''))}
          </p>
        </CardContent>
      </Card>
    </>
  );
}
