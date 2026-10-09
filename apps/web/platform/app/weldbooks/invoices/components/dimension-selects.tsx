import { useMemo } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useDimensionValues } from '@/hooks/queries/use-accounting-queries';
import type { DimensionKind, DimensionValue } from '@/lib/api/domains/weldbooks';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';

/** Select value of "none"; never stored (the line gets `null`). */
const NONE = '__none__';

interface DimensionOption {
  id: string;
  label: string;
}

/**
 * The values of one dimension as select options: active ones, plus the one the
 * line already has when it has since been deactivated. A value under a parent
 * reads "Parent : Child".
 */
export function dimensionOptions(
  values: readonly DimensionValue[],
  dimension: DimensionKind,
  selectedId: string,
  inactiveLabel: (name: string) => string,
): DimensionOption[] {
  const ofKind = values.filter((v) => v.dimension === dimension);
  const byId = new Map(ofKind.map((v) => [v.id, v]));
  const path = (value: DimensionValue): string => {
    const names: string[] = [value.name];
    let parent = value.parentId ? byId.get(value.parentId) : undefined;
    // A parent chain is shallow; the cap only guards against a cycle in bad data.
    for (let depth = 0; parent && depth < 5; depth++) {
      names.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return names.join(' : ');
  };
  return ofKind
    .filter((v) => v.isActive || v.id === selectedId)
    .map((v) => ({ id: v.id, label: v.isActive ? path(v) : inactiveLabel(path(v)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** True when the entity has at least one active class or location to pick. */
export function useHasDimensions(): boolean {
  const { data } = useDimensionValues();
  return (data ?? []).some((v) => v.isActive);
}

interface DimensionSelectsProps {
  idPrefix: string;
  classId: string;
  locationId: string;
  onClassChange: (value: string) => void;
  onLocationChange: (value: string) => void;
  className?: string;
}

function DimensionSelect({
  id,
  label,
  noneLabel,
  value,
  options,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  noneLabel: string;
  value: string;
  options: DimensionOption[];
  onChange: (value: string) => void;
}>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value || NONE} onValueChange={(next) => onChange(next === NONE ? '' : next)}>
        <SelectTrigger id={id} className="shadow-none" aria-label={label}>
          <SelectValue placeholder={noneLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{noneLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Class and location pickers of a document line. A dimension with no values
 * is not shown; with neither, nothing renders, so entities that don't use
 * reporting dimensions never see them.
 */
export function DimensionSelects({
  idPrefix,
  classId,
  locationId,
  onClassChange,
  onLocationChange,
  className,
}: Readonly<DimensionSelectsProps>) {
  const td = useDocumentTexts().line;
  const { data } = useDimensionValues();

  const classes = useMemo(
    () => dimensionOptions(data ?? [], 'class', classId, (name) => td.inactiveValue.replace('{name}', name)),
    [data, classId, td.inactiveValue],
  );
  const locations = useMemo(
    () => dimensionOptions(data ?? [], 'location', locationId, (name) => td.inactiveValue.replace('{name}', name)),
    [data, locationId, td.inactiveValue],
  );

  if (classes.length === 0 && locations.length === 0) return null;

  return (
    <div className={className ?? 'grid grid-cols-1 sm:grid-cols-2 gap-3'}>
      {classes.length > 0 && (
        <DimensionSelect
          id={`${idPrefix}-class`}
          label={td.class}
          noneLabel={td.noDimension}
          value={classId}
          options={classes}
          onChange={onClassChange}
        />
      )}
      {locations.length > 0 && (
        <DimensionSelect
          id={`${idPrefix}-location`}
          label={td.location}
          noneLabel={td.noDimension}
          value={locationId}
          options={locations}
          onChange={onLocationChange}
        />
      )}
    </div>
  );
}
