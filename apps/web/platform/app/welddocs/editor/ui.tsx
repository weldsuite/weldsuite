import { Fragment, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';

// Toolbar building blocks, as in the WeldSheets toolbar. Buttons keep focus in
// the document (mousedown is prevented), so a click formats the selection.

export const BUTTON =
  'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded px-1 text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4';

export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
];

export function WithTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <WithTooltip label={label}>
      <button type="button" className={BUTTON} onClick={onClick} disabled={disabled} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
        {children}
      </button>
    </WithTooltip>
  );
}

export function Toggle({ label, active, onClick, disabled, children }: { label: string; active: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <WithTooltip label={label}>
      <button
        type="button"
        className={`${BUTTON} ${active ? 'bg-accent' : ''}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
      >
        {children}
      </button>
    </WithTooltip>
  );
}

export function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

export interface MenuItemSpec {
  key: string;
  label: ReactNode;
  /** Set on a choice among several: the current one gets a check at the right. */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function Menu({
  label,
  trigger,
  items,
  sections,
  disabled,
  className,
}: {
  label: string;
  trigger: ReactNode;
  items?: MenuItemSpec[];
  sections?: { title?: string; items: MenuItemSpec[] }[];
  disabled?: boolean;
  className?: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <WithTooltip label={label}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button type="button" className={`${BUTTON} ${className ?? ''}`} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
            {trigger}
            <ChevronDown className="!size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="start" className="min-w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
        {items?.map((item) => <MenuEntry key={item.key} item={item} />)}
        {sections?.map((section, i) => (
          <Fragment key={section.title ?? i}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              {section.title && <DropdownMenuLabel>{section.title}</DropdownMenuLabel>}
              {section.items.map((item) => (
                <MenuEntry key={item.key} item={item} />
              ))}
            </DropdownMenuGroup>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MenuEntry({ item }: { item: MenuItemSpec }) {
  return (
    <DropdownMenuItem
      role={item.checked === undefined ? undefined : 'menuitemradio'}
      aria-checked={item.checked}
      disabled={item.disabled}
      onSelect={item.onSelect}
    >
      {item.label}
      {item.checked && <Check className="ml-auto" />}
    </DropdownMenuItem>
  );
}

export function ColorButton({
  label,
  reset,
  value,
  onPick,
  disabled,
  children,
}: {
  label: string;
  reset: string;
  value: string | undefined;
  onPick: (color: string | null) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pick = (color: string | null) => {
    onPick(color);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <WithTooltip label={label}>
        <PopoverTrigger asChild disabled={disabled}>
          <button type="button" className={`${BUTTON} flex-col !gap-0`} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
            {children}
            <span className="h-[3px] w-4 rounded-sm" style={{ backgroundColor: value ?? 'transparent' }} />
          </button>
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent className="w-auto p-2" align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        <Button variant="ghost" size="sm" className="mb-2 w-full justify-start" onClick={() => pick(null)}>
          {reset}
        </Button>
        <div className="grid grid-cols-10 gap-1">
          {PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              className={`h-5 w-5 rounded-sm border ${value === color ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: color }}
              aria-label={color}
              onClick={() => pick(color)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
