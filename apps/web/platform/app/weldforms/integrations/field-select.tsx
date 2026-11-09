import { useMemo } from 'react';
import { fieldsOf, type FieldBlock, type FieldType, type FormDefinition } from '@weldsuite/forms-engine';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';

const NONE = '__none__';

/** The fields of a definition of the given types (all of them when none are given). */
export function fieldsOfTypes(definition: Pick<FormDefinition, 'blocks'>, types?: readonly FieldType[]): FieldBlock[] {
  const all = fieldsOf(definition);
  return types ? all.filter((field) => types.includes(field.type)) : all;
}

/** A picker for one question of the form, optionally with an empty choice. */
export function FieldSelect({
  id,
  label,
  hint,
  definition,
  types,
  value,
  onChange,
  noneLabel,
  placeholder,
}: Readonly<{
  id: string;
  label: string;
  hint?: string;
  definition: Pick<FormDefinition, 'blocks'>;
  types?: readonly FieldType[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Adds an empty choice with this label; without it a question must be picked. */
  noneLabel?: string;
  placeholder?: string;
}>) {
  const { t } = useI18n();
  const fields = useMemo(() => fieldsOfTypes(definition, types), [definition, types]);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || (noneLabel ? NONE : undefined)} onValueChange={(next) => onChange(next === NONE ? undefined : next)}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder ?? t.weldformsResults.integrations.chooseField} />
        </SelectTrigger>
        <SelectContent>
          {noneLabel && <SelectItem value={NONE}>{noneLabel}</SelectItem>}
          {fields.map((field) => (
            <SelectItem key={field.id} value={field.id}>
              {field.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {fields.length === 0 && <p className="text-xs text-muted-foreground">{t.weldformsResults.integrations.noFields}</p>}
    </div>
  );
}
