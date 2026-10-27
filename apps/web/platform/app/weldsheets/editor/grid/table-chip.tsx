import type { CSSProperties } from 'react';
import { ChevronDown, Table2 } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import type { DataTableAction } from '../model/sheet-controller';

const CHIP_CLASS =
  'absolute z-20 flex items-center gap-1 rounded-t-md border border-b-0 border-[#1a73e8] bg-background px-2 text-xs font-medium text-foreground hover:bg-accent dark:border-[#709ff5]';

/**
 * The name of a connected table on its top edge, while the active cell is in
 * it: pressing it selects the whole table, and (with edit rights) opens what
 * can be done with it.
 */
export function TableChip({
  label,
  style,
  readOnly,
  filtered,
  onPick,
  onAction,
  onToggleFilter,
  onOpenChange,
  onClosed,
}: {
  label: string;
  style: CSSProperties;
  readOnly: boolean;
  /** Whether the sheet's filter is on this table's header. */
  filtered: boolean;
  onPick: () => void;
  onAction: (action: DataTableAction) => void;
  onToggleFilter: () => void;
  onOpenChange: (open: boolean) => void;
  /** The menu closed: the grid takes the keyboard back. */
  onClosed: () => void;
}) {
  const { t } = useI18n();
  const td = t.weldsheets.dataSources;
  const face = (
    <>
      <Table2 className="size-3.5 text-[#1a73e8] dark:text-[#709ff5]" />
      <span className="max-w-48 truncate">{label}</span>
    </>
  );
  if (readOnly) {
    return (
      <button type="button" className={CHIP_CLASS} style={style} onClick={onPick} title={td.goTo}>
        {face}
      </button>
    );
  }
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={CHIP_CLASS} style={style} onPointerDown={onPick} aria-label={`${label}: ${td.actions}`}>
          {face}
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuItem onSelect={() => onAction('refresh')}>{td.refreshNow}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleFilter}>{filtered ? td.unfilterTable : td.filterTable}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction('edit')}>{td.edit}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onSelect={() => onAction('disconnect')}>
          {td.disconnect}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
