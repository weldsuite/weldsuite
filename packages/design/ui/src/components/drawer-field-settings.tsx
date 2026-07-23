import { Settings2, RotateCcw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { cn } from '@weldsuite/ui/lib/utils';
import type { DrawerFieldDefinition } from '@weldsuite/ui/lib/drawer-field-registry';

interface DrawerFieldSettingsProps {
  fields: DrawerFieldDefinition[];
  fieldVisibility: Record<string, boolean>;
  onToggle: (fieldId: string) => void;
  onReset: () => void;
  label?: string;
  /** When set, prevents toggling additional fields ON once this many are visible. */
  maxVisible?: number;
}

export function DrawerFieldSettings({
  fields,
  fieldVisibility,
  onToggle,
  onReset,
  label = 'Visible fields',
  maxVisible,
}: DrawerFieldSettingsProps) {
  const visibleCount = fields.reduce(
    (n, f) => n + (f.required || fieldVisibility[f.id] ? 1 : 0),
    0,
  );
  const atCap = maxVisible !== undefined && visibleCount >= maxVisible;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Configure visible fields">
          <Settings2 className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="end">
        <div className="px-3 py-2 border-b border-border flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">
            {label}
            {maxVisible !== undefined && (
              <span className="ml-1 tabular-nums">
                ({visibleCount}/{maxVisible})
              </span>
            )}
          </p>
          <button
            onClick={onReset}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
            title="Reset to defaults"
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
        <div className="p-1 max-h-64 overflow-y-auto">
          {fields.map((field) => {
            const isOn = field.required || fieldVisibility[field.id];
            const disabled = field.required || (atCap && !isOn);
            return (
              <label
                key={field.id}
                className={cn(
                  'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm',
                  disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted cursor-pointer',
                )}
              >
                <Checkbox
                  checked={isOn}
                  disabled={disabled}
                  onCheckedChange={() => onToggle(field.id)}
                />
                <span className={field.required ? 'text-muted-foreground' : ''}>{field.label}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
