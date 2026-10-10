'use client';

import { useMemo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { COUNTRY_CODES, TERRITORY_PRESETS, countryName, normalizeCountries } from '@/lib/partners';
import { partnersCopy } from '@/lib/partners-copy';

/** Country multi-select with regional shortcuts. `conflicts` are shown by the caller. */
export function TerritoryPicker({
  value,
  onChange,
  disabled,
  id,
}: Readonly<{ value: string[]; onChange: (next: string[]) => void; disabled: boolean; id?: string }>) {
  const t = partnersCopy().territories;
  const options = useMemo(
    () =>
      COUNTRY_CODES.map((code) => ({ value: code, label: `${countryName(code)} (${code})` })).sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    [],
  );

  return (
    <div className="space-y-3">
      <MultiSelect
        id={id}
        options={options}
        value={value}
        onChange={(next) => onChange(normalizeCountries(next))}
        disabled={disabled}
        placeholder={t.placeholder}
        searchPlaceholder={t.search}
        emptyText={t.empty}
        aria-label={t.pick}
        modal
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t.presetsTitle}</span>
        {TERRITORY_PRESETS.map((preset) => (
          <Button
            key={preset.key}
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled}
            onClick={() => onChange(normalizeCountries([...value, ...preset.countries]))}
          >
            {t.presets[preset.key]}
          </Button>
        ))}
        <Button type="button" variant="ghost" size="xs" disabled={disabled || value.length === 0} onClick={() => onChange([])}>
          {t.clear}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{t.count.replace('{count}', String(value.length))}</span>
      </div>
    </div>
  );
}
