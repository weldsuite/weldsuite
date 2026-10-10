import { Settings2, RotateCcw } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import type { DrawerFieldDefinition } from '@weldsuite/ui/lib/drawer-field-registry';

interface DrawerFieldSettingsProps {
  fields: DrawerFieldDefinition[];
  fieldVisibility: Record<string, boolean>;
  onToggle: (fieldId: string) => void;
  onReset: () => void;
  label?: string;
  /** When set, prevents toggling additional fields ON once this many are visible. */
  maxVisible?: number;
  /**
   * Trigger button tooltip/aria title. Defaults to "Configure visible
   * fields" — callers that use this picker for something other than object
   * fields (e.g. the person panel's tab visibility) should override it so
   * the affordance matches what it actually configures.
   */
  title?: string;
}

export function DrawerFieldSettings({
  fields,
  fieldVisibility,
  onToggle,
  onReset,
  label = 'Visible fields',
  maxVisible,
  title = 'Configure visible fields',
}: Readonly<DrawerFieldSettingsProps>) {
  const visibleCount = fields.reduce(
    (n, f) => n + (f.required || fieldVisibility[f.id] ? 1 : 0),
    0,
  );
  const atCap = maxVisible !== undefined && visibleCount >= maxVisible;

  // Stock shadcn "toggle columns" menu: checkbox items that keep the menu open.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" title={title}>
          <Settings2 className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          {label}
          {maxVisible !== undefined && (
            <span className="ml-1 tabular-nums">
              ({visibleCount}/{maxVisible})
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {fields.map((field) => {
          const isOn = Boolean(field.required || fieldVisibility[field.id]);
          const disabled = field.required || (atCap && !isOn);
          return (
            <DropdownMenuCheckboxItem
              key={field.id}
              checked={isOn}
              disabled={disabled}
              onCheckedChange={() => onToggle(field.id)}
              onSelect={(event) => event.preventDefault()}
            >
              {field.label}
            </DropdownMenuCheckboxItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onReset();
          }}
        >
          <RotateCcw />
          Reset to defaults
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
