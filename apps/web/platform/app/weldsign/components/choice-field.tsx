import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';

interface ChoiceFieldProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  disabled: boolean;
  onChange: (value: T) => void;
}

/** A labelled select that only reports a change when another option is picked. */
export function ChoiceField<T extends string>({ label, value, options, disabled, onChange }: Readonly<ChoiceFieldProps<T>>) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <Select value={value} disabled={disabled} onValueChange={(next) => next !== value && onChange(next as T)}>
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
