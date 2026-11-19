import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
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
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Euro,
  Grid3x3,
  Italic,
  MoreVertical,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import type { BorderKind, SheetController } from './model/sheet-controller';
import { numberFormats, type NumberFormatKey } from './number-formats';
import { formatShortcut } from './shortcuts';
import { fitGroups } from './toolbar-fit';
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

/** Every number format code the menu can write, in either language, by key. */
function formatKeyOf(numFmt: string | undefined): NumberFormatKey | '' {
  if (!numFmt || numFmt === 'General') return 'automatic';
  for (const language of ['en', 'nl']) {
    const formats = numberFormats(language);
    for (const key of Object.keys(formats) as NumberFormatKey[]) if (formats[key].code === numFmt) return key;
  }
  return '';
}

const MORE_WIDTH = 28;

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
  const formatKey = formatKeyOf(style.numFmt);
  const freeze = controller.sheet.freeze;
  const upToRow = row + 1 > 2;
  const upToColumn = col + 1 > 2;
  const frozen = (n: number, upTo: boolean, at: number) => (upTo && n === at ? 'up' : n <= 2 ? String(n) : '');

  const groups: { key: string; node: ReactNode }[] = [
    {
      key: 'history',
      node: (
        <>
          <IconButton label={tt.undo} shortcut="Mod+Z" onClick={() => controller.undo()} disabled={!controller.canUndo}>
            <Undo2 />
          </IconButton>
          <IconButton label={tt.redo} shortcut="Mod+Shift+Z" onClick={() => controller.redo()} disabled={!controller.canRedo}>
            <Redo2 />
          </IconButton>
        </>
      ),
    },
    {
      key: 'numbers',
      node: (
        <>
          <Toggle label={tt.currency} active={style.numFmt === formats.currency.code || formatKey === 'currency'} onClick={() => controller.format({ numFmt: formats.currency.code })}>
            <Euro />
          </Toggle>
          <Toggle label={tt.percent} active={formatKey === 'percent'} onClick={() => controller.format({ numFmt: formats.percent.code })}>
            <Percent />
          </Toggle>
          <IconButton label={tt.decreaseDecimals} onClick={() => controller.changeDecimals(-1)}>
            <DecimalsArrowLeft />
          </IconButton>
          <IconButton label={tt.increaseDecimals} onClick={() => controller.changeDecimals(1)}>
            <DecimalsArrowRight />
          </IconButton>
          <FormatMenu controller={controller} formatKey={formatKey} />
        </>
      ),
    },
    {
      key: 'fontSize',
      node: (
        <Menu
          label={tt.fontSize}
          trigger={<span className="w-6 text-center text-xs">{style.fontSize ?? 10}</span>}
          value={String(style.fontSize ?? 10)}
          items={FONT_SIZES.map((size) => ({ key: String(size), label: String(size), onSelect: () => controller.format({ fontSize: size }) }))}
        />
      ),
    },
    {
      key: 'text',
      node: (
        <>
          <Toggle label={tt.bold} shortcut="Mod+B" active={!!style.bold} onClick={() => controller.toggle('bold')}>
            <Bold />
          </Toggle>
          <Toggle label={tt.italic} shortcut="Mod+I" active={!!style.italic} onClick={() => controller.toggle('italic')}>
            <Italic />
          </Toggle>
          <Toggle label={tt.strikethrough} shortcut="Mod+5" active={!!style.strike} onClick={() => controller.toggle('strike')}>
            <Strikethrough />
          </Toggle>
          <Toggle label={tt.underline} shortcut="Mod+U" active={!!style.underline} onClick={() => controller.toggle('underline')}>
            <Underline />
          </Toggle>
          <ColorButton label={tt.textColor} reset={tt.resetColor} value={style.color} onPick={(color) => controller.format({ color })}>
            <Baseline />
          </ColorButton>
        </>
      ),
    },
    {
      key: 'cells',
      node: (
        <>
          <ColorButton label={tt.fillColor} reset={tt.resetColor} value={style.fill} onPick={(fill) => controller.format({ fill })}>
            <PaintBucket />
          </ColorButton>
          <BordersMenu controller={controller} />
          <Toggle label={tt.merge} active={!!controller.sheet.mergeAt(row, col)} onClick={() => controller.toggleMerge()}>
            <TableCellsMerge />
          </Toggle>
        </>
      ),
    },
    {
      key: 'align',
      node: (
        <>
          <Menu
            label={tt.horizontalAlign}
            trigger={alignIcon(style.hAlign)}
            value={style.hAlign ?? ''}
            items={[
              { key: 'left', label: t.weldsheets.align.left, onSelect: () => controller.format({ hAlign: 'left' }) },
              { key: 'center', label: t.weldsheets.align.center, onSelect: () => controller.format({ hAlign: 'center' }) },
              { key: 'right', label: t.weldsheets.align.right, onSelect: () => controller.format({ hAlign: 'right' }) },
            ]}
          />
          <Menu
            label={tt.verticalAlign}
            trigger={valignIcon(style.vAlign)}
            value={style.vAlign ?? 'bottom'}
            items={[
              { key: 'top', label: t.weldsheets.align.top, onSelect: () => controller.format({ vAlign: 'top' }) },
              { key: 'middle', label: t.weldsheets.align.middle, onSelect: () => controller.format({ vAlign: 'middle' }) },
              { key: 'bottom', label: t.weldsheets.align.bottom, onSelect: () => controller.format({ vAlign: 'bottom' }) },
            ]}
          />
          <Menu
            label={tt.wrapping}
            trigger={<TextWrap />}
            value={style.wrap ?? 'overflow'}
            items={[
              { key: 'overflow', label: t.weldsheets.align.overflow, onSelect: () => controller.format({ wrap: null }) },
              { key: 'wrap', label: t.weldsheets.align.wrap, onSelect: () => controller.format({ wrap: 'wrap' }) },
              { key: 'clip', label: t.weldsheets.align.clip, onSelect: () => controller.format({ wrap: 'clip' }) },
            ]}
          />
        </>
      ),
    },
    {
      key: 'structure',
      node: (
        <>
          <Menu
            label={tt.freeze}
            trigger={<Snowflake />}
            sections={[
              {
                title: t.weldsheets.freeze.rows,
                value: frozen(freeze.rows, upToRow, row + 1),
                items: [
                  { key: '0', label: t.weldsheets.freeze.noRows, onSelect: () => controller.setFreeze(0, freeze.cols) },
                  { key: '1', label: t.weldsheets.freeze.oneRow, onSelect: () => controller.setFreeze(1, freeze.cols) },
                  { key: '2', label: t.weldsheets.freeze.twoRows, onSelect: () => controller.setFreeze(2, freeze.cols) },
                  ...(upToRow
                    ? [{ key: 'up', label: format(t.weldsheets.freeze.upToRow, { row: row + 1 }), onSelect: () => controller.setFreeze(row + 1, freeze.cols) }]
                    : []),
                ],
              },
              {
                title: t.weldsheets.freeze.columns,
                value: frozen(freeze.cols, upToColumn, col + 1),
                items: [
                  { key: '0', label: t.weldsheets.freeze.noColumns, onSelect: () => controller.setFreeze(freeze.rows, 0) },
                  { key: '1', label: t.weldsheets.freeze.oneColumn, onSelect: () => controller.setFreeze(freeze.rows, 1) },
                  { key: '2', label: t.weldsheets.freeze.twoColumns, onSelect: () => controller.setFreeze(freeze.rows, 2) },
                  ...(upToColumn
                    ? [{ key: 'up', label: format(t.weldsheets.freeze.upToColumn, { col: colToLetters(col) }), onSelect: () => controller.setFreeze(freeze.rows, col + 1) }]
                    : []),
                ],
              },
            ]}
          />
          <Menu
            label={tt.functions}
            trigger={<Sigma />}
            items={['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((name) => ({ key: name, label: name, onSelect: () => controller.insertFunction(name) }))}
          />
          <IconButton label={tt.clearFormatting} shortcut="Mod+\" onClick={() => controller.clearFormatting()}>
            <RemoveFormatting />
          </IconButton>
        </>
      ),
    },
    {
      key: 'data',
      node: (
        <>
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
        </>
      ),
    },
    {
      key: 'insert',
      node: (
        <>
          <IconButton label={t.weldsheets.charts.insert} onClick={() => insertChart(controller)}>
            <ChartColumnBig />
          </IconButton>
          <IconButton label={t.weldsheets.pivot.create} onClick={onCreatePivot}>
            <Table2 />
          </IconButton>
        </>
      ),
    },
  ];

  // Groups that don't fit move behind a trailing "More" button. A hidden copy of
  // the row is measured, so widths are known for groups that aren't shown.
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(groups.length);
  const [moreOpen, setMoreOpen] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const read = () => setWidth(root.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Runs after every render: a group's width changes with its content (font size digits, filter label).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure || width === 0) return;
    const widths = Array.from(measure.children, (child) => child.getBoundingClientRect().width);
    const next = fitGroups(widths, width - 16, MORE_WIDTH);
    if (next !== visible) setVisible(next);
    if (next >= groups.length && moreOpen) setMoreOpen(false);
  });

  const shown = groups.slice(0, visible);
  const overflow = groups.slice(visible);

  return (
    <div ref={rootRef} className="relative flex h-12 shrink-0 items-center gap-0.5 overflow-hidden border-b px-2" role="toolbar" aria-label={t.weldsheets.title}>
      <div ref={measureRef} className="pointer-events-none invisible absolute top-0 left-2 flex w-max gap-0.5" aria-hidden inert>
        {groups.map((group, i) => (
          <Group key={group.key} divider={i > 0}>
            {group.node}
          </Group>
        ))}
      </div>
      {shown.map((group, i) => (
        <Group key={group.key} divider={i > 0}>
          {group.node}
        </Group>
      ))}
      {overflow.length > 0 && (
        <Popover open={moreOpen} onOpenChange={setMoreOpen}>
          <WithTooltip label={tt.more}>
            <PopoverTrigger asChild>
              <button type="button" className={`${BUTTON} ml-auto`} aria-label={tt.more} onMouseDown={(e) => e.preventDefault()}>
                <MoreVertical />
              </button>
            </PopoverTrigger>
          </WithTooltip>
          <FocusablePopoverContent
            className="flex w-auto max-w-[min(32rem,calc(100vw-1rem))] flex-wrap items-center gap-0.5 p-1"
            align="end"
            collisionPadding={8}
            // Done once a control has acted (a button, or a choice in one of its menus, which
            // bubbles here through the portal); a trigger that opens a menu or picker keeps it open.
            onClick={(e) => {
              const target = e.target as HTMLElement;
              const acted = target.closest('[role^="menuitem"]') ?? target.closest('button:not([aria-haspopup])');
              if (acted) setMoreOpen(false);
            }}
          >
            {overflow.map((group, i) => (
              <Group key={group.key} divider={i > 0}>
                {group.node}
              </Group>
            ))}
          </FocusablePopoverContent>
        </Popover>
      )}
    </div>
  );
}

function Group({ divider, children }: { divider: boolean; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {divider && <Divider />}
      {children}
    </div>
  );
}

/**
 * A popover that takes focus itself when it opens, so that opening it with the
 * pointer paints no focus ring on its first control; Tab still reaches them.
 */
function FocusablePopoverContent({ children, ...props }: ComponentProps<typeof PopoverContent>) {
  return (
    <PopoverContent
      tabIndex={-1}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={(e) => e.preventDefault()}
      {...props}
    >
      {children}
    </PopoverContent>
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

function FormatMenu({ controller, formatKey }: { controller: SheetController; formatKey: NumberFormatKey | '' }) {
  const { t, language } = useI18n();
  const formats = numberFormats(language);
  const keys: NumberFormatKey[] = ['automatic', 'plainText', 'number', 'percent', 'scientific', 'accounting', 'currency', 'date', 'time', 'dateTime', 'duration'];
  return (
    <Menu
      label={t.weldsheets.toolbar.moreFormats}
      trigger={<span className="text-xs font-semibold">123</span>}
      value={formatKey}
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
      items={kinds.map((kind) => ({
        key: kind,
        label: t.weldsheets.borders[kind],
        icon: <BorderIcon kind={kind} />,
        onSelect: () => controller.setBorders(kind),
      }))}
    />
  );
}

/** Where each border kind draws on a 2×2 block of cells (16×16 box). */
const BORDER_LINES: Record<'top' | 'bottom' | 'left' | 'right' | 'inner', string> = {
  top: 'M2 2H14',
  bottom: 'M2 14H14',
  left: 'M2 2V14',
  right: 'M14 2V14',
  inner: 'M8 2V14M2 8H14',
};

const BORDER_SIDES: Record<BorderKind, (keyof typeof BORDER_LINES)[]> = {
  all: ['top', 'bottom', 'left', 'right', 'inner'],
  outer: ['top', 'bottom', 'left', 'right'],
  inner: ['inner'],
  top: ['top'],
  bottom: ['bottom'],
  left: ['left'],
  right: ['right'],
  none: [],
};

/** A 2×2 block of cells, its lines dotted, with the borders `kind` sets drawn solid. */
function BorderIcon({ kind }: { kind: BorderKind }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" aria-hidden>
      <path d={Object.values(BORDER_LINES).join('')} strokeWidth={1} strokeDasharray="0.5 2" opacity={0.5} />
      {BORDER_SIDES[kind].map((side) => (
        <path key={side} d={BORDER_LINES[side]} strokeWidth={1.5} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const BUTTON =
  'inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-0.5 rounded px-1 text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4';

/** A tooltip with the label and, when the control has one, its keyboard shortcut (`Mod+B`, written for the platform). */
function WithTooltip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <kbd className="ml-2 font-sans opacity-70">{formatShortcut(shortcut)}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function IconButton({
  label,
  shortcut,
  onClick,
  disabled,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <WithTooltip label={label} shortcut={shortcut}>
      <button type="button" className={BUTTON} onClick={onClick} disabled={disabled} aria-label={label} onMouseDown={(e) => e.preventDefault()}>
        {children}
      </button>
    </WithTooltip>
  );
}

function Toggle({ label, shortcut, active, onClick, children }: { label: string; shortcut?: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <WithTooltip label={label} shortcut={shortcut}>
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
  /** Drawn before the label. */
  icon?: ReactNode;
  hint?: string;
  onSelect: () => void;
}

/** `value` makes the items a set of choices (radio items, the current one checked); '' selects none. */
function Menu({
  label,
  trigger,
  items,
  value,
  sections,
}: {
  label: string;
  trigger: ReactNode;
  items?: MenuItemSpec[];
  value?: string;
  sections?: { title: string; value?: string; items: MenuItemSpec[] }[];
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
        {items && <MenuItems items={items} value={value} />}
        {sections?.map((section, i) => (
          <div key={section.title}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-xs text-muted-foreground">{section.title}</DropdownMenuLabel>
            <MenuItems items={section.items} value={section.value} />
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItems({ items, value }: { items: MenuItemSpec[]; value?: string }) {
  if (value === undefined) return items.map((item) => <MenuEntry key={item.key} item={item} />);
  return (
    <DropdownMenuRadioGroup value={value}>
      {items.map((item) => (
        <DropdownMenuRadioItem key={item.key} value={item.key} indicator="check" onSelect={item.onSelect}>
          <MenuEntryText item={item} />
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

function MenuEntry({ item }: { item: MenuItemSpec }) {
  return (
    <DropdownMenuItem onSelect={item.onSelect}>
      <MenuEntryText item={item} />
    </DropdownMenuItem>
  );
}

function MenuEntryText({ item }: { item: MenuItemSpec }) {
  return (
    <>
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {item.hint && <span className="ml-4 text-xs text-muted-foreground">{item.hint}</span>}
    </>
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
      <FocusablePopoverContent className="w-auto p-2" align="start">
        <button type="button" className="mb-2 w-full rounded px-2 py-1 text-left text-sm hover:bg-accent" onClick={() => pick(null)}>
          {reset}
        </button>
        <div className="grid grid-cols-10 gap-1">
          {PALETTE.map((color) => (
            <button
              key={color}
              type="button"
              className={`h-5 w-5 rounded-sm border border-foreground/50 ${value === color ? 'ring-2 ring-primary ring-offset-1' : ''}`}
              style={{ backgroundColor: color }}
              aria-label={color}
              onClick={() => pick(color)}
            />
          ))}
        </div>
      </FocusablePopoverContent>
    </Popover>
  );
}
