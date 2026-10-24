import { useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  AlignVerticalJustifyCenter,
  ArrowDownAZ,
  ChartColumnBig,
  Table2,
  ListChecks,
  ListFilter,
  PaintRoller,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  Baseline,
  Bold,
  ChevronDown,
  Euro,
  Grid3x3,
  Italic,
  PaintBucket,
  Percent,
  Redo2,
  RemoveFormatting,
  Sigma,
  Snowflake,
  Strikethrough,
  TableCellsMerge,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignStart,
  TextWrap,
  Underline,
  Undo2,
} from 'lucide-react';
import { colToLetters, type CellStyle } from '@weldsuite/sheets-engine';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import type { BorderKind, SheetController } from './model/sheet-controller';
import { numberFormats, type NumberFormatKey } from './number-formats';
import { insertChart } from './model/charts';
import { sortByColumn, toggleFilter } from './model/rules';
import { toast } from 'sonner';

const FONT_SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 36];

const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#cccccc', '#d9d9d9', '#efefef', '#f3f3f3', '#ffffff',
  '#980000', '#ff0000', '#ff9900', '#ffff00', '#00ff00', '#00ffff', '#4a86e8', '#0000ff', '#9900ff', '#ff00ff',
  '#e6b8af', '#f4cccc', '#fce5cd', '#fff2cc', '#d9ead3', '#d0e0e3', '#c9daf8', '#cfe2f3', '#d9d2e9', '#ead1dc',
  '#dd7e6b', '#ea9999', '#f9cb9c', '#ffe599', '#b6d7a8', '#a2c4c9', '#a4c2f4', '#9fc5e8', '#b4a7d6', '#d5a6bd',
  '#a61c00', '#cc0000', '#e69138', '#f1c232', '#6aa84f', '#45818e', '#3c78d8', '#3d85c6', '#674ea7', '#a64d79',
];

export function Toolbar({ controller, onSortRange, onCreatePivot }: { controller: SheetController; onSortRange: () => void; onCreatePivot: () => void }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t, format, language } = useI18n();
  const tt = t.weldsheets.toolbar;
  const style: CellStyle = controller.activeStyle();
  const formats = numberFormats(language);
  const { row, col } = controller.selection.active;
  const td = t.weldsheets.data;
  const sortBy = (descending: boolean) => {
    const problem = sortByColumn(controller, col, descending);
    if (problem) toast.error(problem === 'merged' ? td.sortMerged : td.sortNothing);
  };
  const togglePanel = (panel: 'formats' | 'validation') => controller.openPanel(controller.panel === panel ? null : panel);

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2" role="toolbar" aria-label={t.weldsheets.title}>
      <IconButton label={tt.undo} onClick={() => controller.undo()} disabled={!controller.canUndo}>
        <Undo2 />
      </IconButton>
      <IconButton label={tt.redo} onClick={() => controller.redo()} disabled={!controller.canRedo}>
        <Redo2 />
      </IconButton>
      <Divider />
      <IconButton label={tt.currency} onClick={() => controller.format({ numFmt: formats.currency.code })}>
        <Euro />
      </IconButton>
      <IconButton label={tt.percent} onClick={() => controller.format({ numFmt: formats.percent.code })}>
        <Percent />
      </IconButton>
      <IconButton label={tt.decreaseDecimals} onClick={() => controller.changeDecimals(-1)}>
        <span className="text-[11px] font-semibold">.0←</span>
      </IconButton>
      <IconButton label={tt.increaseDecimals} onClick={() => controller.changeDecimals(1)}>
        <span className="text-[11px] font-semibold">.00→</span>
      </IconButton>
      <FormatMenu controller={controller} />
      <Divider />
      <Menu
        label={tt.fontSize}
        trigger={<span className="w-6 text-center text-xs">{style.fontSize ?? 10}</span>}
        items={FONT_SIZES.map((size) => ({ key: String(size), label: String(size), onSelect: () => controller.format({ fontSize: size }) }))}
      />
      <Divider />
      <Toggle label={tt.bold} active={!!style.bold} onClick={() => controller.toggle('bold')}>
        <Bold />
      </Toggle>
      <Toggle label={tt.italic} active={!!style.italic} onClick={() => controller.toggle('italic')}>
        <Italic />
      </Toggle>
      <Toggle label={tt.strikethrough} active={!!style.strike} onClick={() => controller.toggle('strike')}>
        <Strikethrough />
      </Toggle>
      <Toggle label={tt.underline} active={!!style.underline} onClick={() => controller.toggle('underline')}>
        <Underline />
      </Toggle>
      <ColorButton label={tt.textColor} reset={tt.resetColor} value={style.color} onPick={(color) => controller.format({ color })}>
        <Baseline />
      </ColorButton>
      <Divider />
      <ColorButton label={tt.fillColor} reset={tt.resetColor} value={style.fill} onPick={(fill) => controller.format({ fill })}>
        <PaintBucket />
      </ColorButton>
      <BordersMenu controller={controller} />
      <IconButton label={tt.merge} onClick={() => controller.toggleMerge()}>
        <TableCellsMerge />
      </IconButton>
      <Divider />
      <Menu
        label={tt.horizontalAlign}
        trigger={alignIcon(style.hAlign)}
        items={[
          { key: 'left', label: t.weldsheets.align.left, onSelect: () => controller.format({ hAlign: 'left' }) },
          { key: 'center', label: t.weldsheets.align.center, onSelect: () => controller.format({ hAlign: 'center' }) },
          { key: 'right', label: t.weldsheets.align.right, onSelect: () => controller.format({ hAlign: 'right' }) },
        ]}
      />
      <Menu
        label={tt.verticalAlign}
        trigger={valignIcon(style.vAlign)}
        items={[
          { key: 'top', label: t.weldsheets.align.top, onSelect: () => controller.format({ vAlign: 'top' }) },
          { key: 'middle', label: t.weldsheets.align.middle, onSelect: () => controller.format({ vAlign: 'middle' }) },
          { key: 'bottom', label: t.weldsheets.align.bottom, onSelect: () => controller.format({ vAlign: 'bottom' }) },
        ]}
      />
      <Menu
        label={tt.wrapping}
        trigger={<TextWrap />}
        items={[
          { key: 'overflow', label: t.weldsheets.align.overflow, onSelect: () => controller.format({ wrap: null }) },
          { key: 'wrap', label: t.weldsheets.align.wrap, onSelect: () => controller.format({ wrap: 'wrap' }) },
          { key: 'clip', label: t.weldsheets.align.clip, onSelect: () => controller.format({ wrap: 'clip' }) },
        ]}
      />
      <Divider />
      <Menu
        label={tt.freeze}
        trigger={<Snowflake />}
        sections={[
          {
            title: t.weldsheets.freeze.rows,
            items: [
              { key: 'r0', label: t.weldsheets.freeze.noRows, onSelect: () => controller.setFreeze(0, controller.sheet.freeze.cols) },
              { key: 'r1', label: t.weldsheets.freeze.oneRow, onSelect: () => controller.setFreeze(1, controller.sheet.freeze.cols) },
              { key: 'r2', label: t.weldsheets.freeze.twoRows, onSelect: () => controller.setFreeze(2, controller.sheet.freeze.cols) },
              {
                key: 'rn',
                label: format(t.weldsheets.freeze.upToRow, { row: row + 1 }),
                onSelect: () => controller.setFreeze(row + 1, controller.sheet.freeze.cols),
              },
            ],
          },
          {
            title: t.weldsheets.freeze.columns,
            items: [
              { key: 'c0', label: t.weldsheets.freeze.noColumns, onSelect: () => controller.setFreeze(controller.sheet.freeze.rows, 0) },
              { key: 'c1', label: t.weldsheets.freeze.oneColumn, onSelect: () => controller.setFreeze(controller.sheet.freeze.rows, 1) },
              { key: 'c2', label: t.weldsheets.freeze.twoColumns, onSelect: () => controller.setFreeze(controller.sheet.freeze.rows, 2) },
              {
                key: 'cn',
                label: format(t.weldsheets.freeze.upToColumn, { col: colToLetters(col) }),
                onSelect: () => controller.setFreeze(controller.sheet.freeze.rows, col + 1),
              },
            ],
          },
        ]}
      />
      <Menu
        label={tt.functions}
        trigger={<Sigma />}
        items={['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((name) => ({ key: name, label: name, onSelect: () => controller.insertFunction(name) }))}
      />
      <IconButton label={tt.clearFormatting} onClick={() => controller.clearFormatting()}>
        <RemoveFormatting />
      </IconButton>
      <Divider />
      <Toggle label={controller.sheet.filter ? td.removeFilter : td.createFilter} active={!!controller.sheet.filter} onClick={() => toggleFilter(controller)}>
        <ListFilter />
      </Toggle>
      <Menu
        label={td.sort}
        trigger={<ArrowDownAZ />}
        items={[
          { key: 'asc', label: td.sortAsc, onSelect: () => sortBy(false) },
          { key: 'desc', label: td.sortDesc, onSelect: () => sortBy(true) },
          { key: 'range', label: td.sortRange, onSelect: onSortRange },
        ]}
      />
      <Toggle label={td.conditionalFormatting} active={controller.panel === 'formats'} onClick={() => togglePanel('formats')}>
        <PaintRoller />
      </Toggle>
      <Toggle label={td.dataValidation} active={controller.panel === 'validation'} onClick={() => togglePanel('validation')}>
        <ListChecks />
      </Toggle>
      <Divider />
      <IconButton label={t.weldsheets.charts.insert} onClick={() => insertChart(controller)}>
        <ChartColumnBig />
      </IconButton>
      <IconButton label={t.weldsheets.pivot.create} onClick={onCreatePivot}>
        <Table2 />
      </IconButton>
    </div>
  );
}

function alignIcon(align: CellStyle['hAlign']) {
  if (align === 'center') return <TextAlignCenter />;
  if (align === 'right') return <TextAlignEnd />;
  return <TextAlignStart />;
}

function valignIcon(align: CellStyle['vAlign']) {
  if (align === 'top') return <AlignVerticalJustifyStart />;
  if (align === 'middle') return <AlignVerticalJustifyCenter />;
  return <AlignVerticalJustifyEnd />;
}

function FormatMenu({ controller }: { controller: SheetController }) {
  const { t, language } = useI18n();
  const formats = numberFormats(language);
  const keys: NumberFormatKey[] = ['automatic', 'plainText', 'number', 'percent', 'scientific', 'accounting', 'currency', 'date', 'time', 'dateTime', 'duration'];
  return (
    <Menu
      label={t.weldsheets.toolbar.moreFormats}
      trigger={<span className="text-xs font-semibold">123</span>}
      items={keys.map((key) => ({
        key,
        label: t.weldsheets.formats[key],
        hint: formats[key].example,
        onSelect: () => controller.format({ numFmt: formats[key].code }),
      }))}
    />
  );
}

function BordersMenu({ controller }: { controller: SheetController }) {
  const { t } = useI18n();
  const kinds: BorderKind[] = ['all', 'outer', 'inner', 'top', 'bottom', 'left', 'right', 'none'];
  return (
    <Menu
      label={t.weldsheets.toolbar.borders}
      trigger={<Grid3x3 />}
      items={kinds.map((kind) => ({ key: kind, label: t.weldsheets.borders[kind], onSelect: () => controller.setBorders(kind) }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const BUTTON =
  'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded px-1 text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4';

function WithTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <WithTooltip label={label}>
      <button type="button" className={BUTTON} onClick={onClick} disabled={disabled} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
        {children}
      </button>
    </WithTooltip>
  );
}

function Toggle({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <WithTooltip label={label}>
      <button
        type="button"
        className={`${BUTTON} ${active ? 'bg-accent' : ''}`}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
      >
        {children}
      </button>
    </WithTooltip>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

interface MenuItemSpec {
  key: string;
  label: string;
  hint?: string;
  onSelect: () => void;
}

function Menu({
  label,
  trigger,
  items,
  sections,
}: {
  label: string;
  trigger: ReactNode;
  items?: MenuItemSpec[];
  sections?: { title: string; items: MenuItemSpec[] }[];
}) {
  return (
    <DropdownMenu modal={false}>
      <WithTooltip label={label}>
        <DropdownMenuTrigger asChild>
          <button type="button" className={BUTTON} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
            {trigger}
            <ChevronDown className="!size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="start" className="min-w-44" onCloseAutoFocus={(e) => e.preventDefault()}>
        {items?.map((item) => <MenuEntry key={item.key} item={item} />)}
        {sections?.map((section, i) => (
          <div key={section.title}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{section.title}</DropdownMenuLabel>
            {section.items.map((item) => (
              <MenuEntry key={item.key} item={item} />
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuEntry({ item }: { item: MenuItemSpec }) {
  return (
    <DropdownMenuItem onSelect={item.onSelect}>
      <span className="flex-1">{item.label}</span>
      {item.hint && <span className="ml-4 text-xs text-muted-foreground">{item.hint}</span>}
    </DropdownMenuItem>
  );
}

function ColorButton({
  label,
  reset,
  value,
  onPick,
  children,
}: {
  label: string;
  reset: string;
  value: string | undefined;
  onPick: (color: string | null) => void;
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
        <PopoverTrigger asChild>
          <button type="button" className={`${BUTTON} flex-col !gap-0`} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
            {children}
            <span className="h-[3px] w-4 rounded-sm" style={{ backgroundColor: value ?? 'transparent' }} />
          </button>
        </PopoverTrigger>
      </WithTooltip>
      <PopoverContent className="w-auto p-2" align="start" onCloseAutoFocus={(e) => e.preventDefault()}>
        <button type="button" className="mb-2 w-full rounded px-2 py-1 text-left text-sm hover:bg-accent" onClick={() => pick(null)}>
          {reset}
        </button>
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
