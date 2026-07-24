import { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { useSpreadsheet } from './use-spreadsheet';
import { SpreadsheetGrid, type SpreadsheetClipboardApi } from './spreadsheet-grid';
import { SheetTabBar } from './sheet-tab-bar';
import { FormulaBar } from './formula-bar';
import { SpreadsheetContextMenu } from './spreadsheet-context-menu';
import { PageLoader } from '@/components/page-loader';
import type { CellCoord, CellFormat, RichTextRun, CellDataValue } from './types';
import { normRange, colLabel } from './types';
import { formatKey, getCellFormat, mergeFormat, noteKey, linkKey, getCellNote, getCellLink } from './cell-format';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  applyFormatToRange,
  isAllBold,
  isAllItalic,
  isAllStrikethrough,
  runsFromPlainText,
  runsToHtml,
  htmlToRuns,
  saveSelection,
  restoreSelection,
  plainTextFromRuns,
} from './rich-text';
import { cn } from '@/lib/utils';
import {
  Bold,
  Italic,
  Strikethrough,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  Undo2,
  Redo2,
  Type,
  Percent,
  DollarSign,
  PaintBucket,
  Link,
  MessageSquare,
  TextWrap,
  RotateCw,
  Grid3X3,
  Merge,
  SquareFunction,
  Minus,
  Plus,
  Paintbrush,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';

// Color values are locale-independent; labels are translated inside the component
const textColorValues = [
  '#000000', '#374151', '#6B7280', '#DC2626', '#EA580C',
  '#CA8A04', '#16A34A', '#2563EB', '#9333EA', '#DB2777',
];

const fontFamilies = [
  { value: 'sans-serif' },
  { value: 'Arial' },
  { value: 'Helvetica' },
  { value: 'Times New Roman' },
  { value: 'Courier New' },
  { value: 'Georgia' },
  { value: 'Verdana' },
];

const fontSizes = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36'];

interface ToolbarProps {
  onFormat: (format: Partial<CellFormat>) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  paintFormatActive?: boolean;
  onPaintFormat?: () => void;
  onBack?: () => void;
  tableName?: string;
  showFormulaBar?: boolean;
  onToggleFormulaBar?: () => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  activeFormat?: CellFormat;
  onMergeCells?: () => void;
  mergeActive?: boolean;
  onInsertLink?: () => void;
  onComment?: () => void;
  onInsertFunction?: () => void;
}

const TB = { height: 28, width: 28, minHeight: 28 } as const;
const Sep = () => <div className="w-px h-5 bg-border mx-0.5" />;

// Assigns a single CellFormat field by a dynamically-known key, correlating the
// key and value types so callers looping over `Object.keys(...)` don't need `any`.
function setFormatKey<K extends keyof CellFormat>(
  target: Partial<CellFormat>,
  key: K,
  value: CellFormat[K] | undefined,
): void {
  target[key] = value;
}

// `onBack` / `tableName` are part of the shared ToolbarProps contract but this
// toolbar doesn't render a back button or title — kept for callers that pass them.
function SpreadsheetToolbar({ onFormat, onUndo, onRedo, canUndo, canRedo, paintFormatActive, onPaintFormat, showFormulaBar, onToggleFormulaBar, zoom, onZoomChange, activeFormat, onMergeCells, mergeActive, onInsertLink, onComment, onInsertFunction }: ToolbarProps) {
  const [fontFamily, setFontFamily] = useState('sans-serif');
  const [fontSize, setFontSize] = useState('10');
  const [fontFamilyOpen, setFontFamilyOpen] = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [textColorOpen, setTextColorOpen] = useState(false);
  const { t } = useI18n();
  const [fillColorOpen, setFillColorOpen] = useState(false);
  const [bordersOpen, setBordersOpen] = useState(false);
  const [moreFormatsOpen, setMoreFormatsOpen] = useState(false);

  // Sync toolbar state with active cell format
  useEffect(() => {
    setFontSize(activeFormat?.fontSize?.toString() || '10');
    setFontFamily(activeFormat?.fontFamily || 'sans-serif');
  }, [activeFormat]);
  const [vertAlignOpen, setVertAlignOpen] = useState(false);
  const [wrapOpen, setWrapOpen] = useState(false);
  const [rotationOpen, setRotationOpen] = useState(false);

  return (
    <div className="bg-background w-full border-b shrink-0">
      <div className="flex items-center gap-0.5 px-3 h-[47px] overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {/* Undo / Redo */}
        <Button variant="ghost" size="sm" className="p-0" style={TB} disabled={!canUndo} onClick={onUndo} title={t.projects.table.undoTitle}>
          <Undo2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} disabled={!canRedo} onClick={onRedo} title={t.projects.table.redoTitle}>
          <Redo2 className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className={`p-0 ${paintFormatActive ? 'bg-accent' : ''}`} style={TB} onClick={onPaintFormat} title={t.projects.table.paintFormatTitle}>
          <Paintbrush className="h-3.5 w-3.5" />
        </Button>

        <Sep />

        {/* Number format */}
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={() => onFormat({ numberFormat: 'currency' })} title={t.projects.table.currencyTitle}>
          <DollarSign className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={() => onFormat({ numberFormat: 'percent' })} title={t.projects.table.percentTitle}>
          <Percent className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={() => onFormat({ decimalPlaces: -1 })} title={t.projects.table.decreaseFontTitle}>
          <span className="text-xs font-mono">.0</span>
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={() => onFormat({ decimalPlaces: 1 })} title={t.projects.table.increaseFontTitle}>
          <span className="text-xs font-mono">.00</span>
        </Button>

        <Popover open={moreFormatsOpen} onOpenChange={setMoreFormatsOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0" style={TB} title={t.projects.table.moreFormatsTitle}>
              <span className="text-xs font-mono">123</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-40 p-1" align="start">
            {[
              { label: t.projects.table.formatAutomatic, value: undefined },
              { label: t.projects.table.formatPlainText, value: 'text' },
              { label: t.projects.table.formatNumber, value: 'number' },
              { label: t.projects.table.formatCurrency, value: 'currency' },
              { label: t.projects.table.formatPercent, value: 'percent' },
              { label: t.projects.table.formatDate, value: 'date' },
            ].map((f) => (
              <Button
                key={f.label}
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs h-7"
                onClick={() => { onFormat({ numberFormat: f.value as CellFormat['numberFormat'] }); setMoreFormatsOpen(false); }}
              >
                {f.label}
              </Button>
            ))}
          </PopoverContent>
        </Popover>

        <Sep />

        {/* Font family */}
        <Popover open={fontFamilyOpen} onOpenChange={setFontFamilyOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="px-2 h-7 text-xs max-w-[100px] truncate" title={t.projects.table.fontTitle}>
              {fontFamily === 'sans-serif' ? t.projects.table.fontDefault : fontFamily}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-40 p-1" align="start">
            {fontFamilies.map((f) => (
              <Button
                key={f.value}
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs h-7"
                style={{ fontFamily: f.value }}
                onClick={() => { setFontFamily(f.value); onFormat({ fontFamily: f.value }); setFontFamilyOpen(false); }}
              >
                {f.value === 'sans-serif' ? t.projects.table.fontDefault : f.value}
              </Button>
            ))}
          </PopoverContent>
        </Popover>

        <Sep />

        {/* Font size */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="p-0 h-7 w-7"
            title={t.projects.table.decreaseFontTitle}
            onClick={() => {
              const idx = fontSizes.indexOf(fontSize);
              if (idx > 0) {
                const newSize = fontSizes[idx - 1];
                setFontSize(newSize);
                onFormat({ fontSize: Number(newSize) });
              }
            }}
          >
            <Minus className="h-3 w-3" />
          </Button>
          <Popover open={fontSizeOpen} onOpenChange={setFontSizeOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="px-1.5 h-7 text-xs w-9 border border-input rounded-md" title={t.projects.table.fontTitle}>
                {fontSize}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-16 p-1" align="start">
              {fontSizes.map((s) => (
                <Button
                  key={s}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-center text-xs h-7"
                  onClick={() => { setFontSize(s); onFormat({ fontSize: Number(s) }); setFontSizeOpen(false); }}
                >
                  {s}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            className="p-0 h-7 w-7"
            title={t.projects.table.increaseFontTitle}
            onClick={() => {
              const idx = fontSizes.indexOf(fontSize);
              if (idx < fontSizes.length - 1) {
                const newSize = fontSizes[idx + 1];
                setFontSize(newSize);
                onFormat({ fontSize: Number(newSize) });
              }
            }}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        <Sep />

        {/* Bold / Italic / Strikethrough */}
        <Button variant="ghost" size="sm" className={cn("p-0", activeFormat?.bold && "bg-muted")} style={TB} onMouseDown={(e) => e.preventDefault()} onClick={() => onFormat({ bold: true })} title={t.projects.table.boldTitle}>
          <Bold className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className={cn("p-0", activeFormat?.italic && "bg-muted")} style={TB} onMouseDown={(e) => e.preventDefault()} onClick={() => onFormat({ italic: true })} title={t.projects.table.italicTitle}>
          <Italic className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className={cn("p-0", activeFormat?.strikethrough && "bg-muted")} style={TB} onMouseDown={(e) => e.preventDefault()} onClick={() => onFormat({ strikethrough: true })} title={t.projects.table.strikethroughTitle}>
          <Strikethrough className="h-3.5 w-3.5" />
        </Button>

        {/* Text color */}
        <Popover open={textColorOpen} onOpenChange={setTextColorOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0" style={TB} title={t.projects.table.textColorTitle}>
              <Type className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <div className="grid grid-cols-5 gap-1">
              {textColorValues.map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  className="w-6 h-6 rounded border hover:scale-110 transition-transform p-0"
                  style={{ backgroundColor: value }}
                  onClick={() => { onFormat({ textColor: value }); setTextColorOpen(false); }}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {/* Fill color */}
        <Popover open={fillColorOpen} onOpenChange={setFillColorOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0" style={TB} title={t.projects.table.fillColorTitle}>
              <PaintBucket className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <div className="grid grid-cols-5 gap-1">
              <Button
                variant="ghost"
                className="w-6 h-6 rounded border hover:scale-110 transition-transform bg-white dark:bg-gray-900 flex items-center justify-center text-[8px] p-0"
                title={t.projects.table.noFillTitle}
                onClick={() => { onFormat({ fillColor: undefined }); setFillColorOpen(false); }}
              >
                ✕
              </Button>
              {textColorValues.map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  className="w-6 h-6 rounded border hover:scale-110 transition-transform p-0"
                  style={{ backgroundColor: value + '30' }}
                  onClick={() => { onFormat({ fillColor: value + '30' }); setFillColorOpen(false); }}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Sep />

        {/* Borders */}
        <Popover open={bordersOpen} onOpenChange={setBordersOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0" style={TB} title={t.projects.table.bordersTitle}>
              <Grid3X3 className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-40 p-1" align="start">
            {[
              { label: t.projects.table.borderAll, value: 'all' },
              { label: t.projects.table.borderNone, value: 'none' },
              { label: t.projects.table.borderBottom, value: 'bottom' },
              { label: t.projects.table.borderTop, value: 'top' },
              { label: t.projects.table.borderLeft, value: 'left' },
              { label: t.projects.table.borderRight, value: 'right' },
            ].map((b) => (
              <Button
                key={b.value}
                variant="ghost"
                size="sm"
                className="w-full justify-start text-xs h-7"
                onClick={() => { onFormat({ border: b.value as CellFormat['border'] }); setBordersOpen(false); }}
              >
                {b.label}
              </Button>
            ))}
          </PopoverContent>
        </Popover>

        {/* Merge */}
        <Button variant="ghost" size="sm" className={cn("p-0", mergeActive && "bg-muted")} style={TB} onClick={onMergeCells} title={t.projects.table.mergeTitle}>
          <Merge className="h-3.5 w-3.5" />
        </Button>

        <Sep />

        {/* Horizontal alignment */}
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={() => onFormat({ textAlign: 'left' })} title={t.projects.table.horizontalAlignTitle}>
          <AlignLeft className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={() => onFormat({ textAlign: 'center' })} title={t.projects.table.horizontalAlignTitle}>
          <AlignCenter className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={() => onFormat({ textAlign: 'right' })} title={t.projects.table.horizontalAlignTitle}>
          <AlignRight className="h-3.5 w-3.5" />
        </Button>

        <Sep />

        {/* Vertical alignment */}
        <Popover open={vertAlignOpen} onOpenChange={setVertAlignOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0" style={TB} title={t.projects.table.verticalAlignTitle}>
              <AlignVerticalJustifyCenter className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-32 p-1" align="start">
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ verticalAlign: 'top' }); setVertAlignOpen(false); }}>
              <AlignVerticalJustifyStart className="h-3 w-3 mr-2" /> {t.projects.table.vertAlignTop}
            </Button>
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ verticalAlign: 'middle' }); setVertAlignOpen(false); }}>
              <AlignVerticalJustifyCenter className="h-3 w-3 mr-2" /> {t.projects.table.vertAlignMiddle}
            </Button>
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ verticalAlign: 'bottom' }); setVertAlignOpen(false); }}>
              <AlignVerticalJustifyEnd className="h-3 w-3 mr-2" /> {t.projects.table.vertAlignBottom}
            </Button>
          </PopoverContent>
        </Popover>

        {/* Text wrapping */}
        <Popover open={wrapOpen} onOpenChange={setWrapOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0" style={TB} title={t.projects.table.wrapTitle}>
              <TextWrap className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-32 p-1" align="start">
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ textWrap: 'overflow' }); setWrapOpen(false); }}>{t.projects.table.wrapOverflow}</Button>
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ textWrap: 'wrap' }); setWrapOpen(false); }}>{t.projects.table.wrapWrap}</Button>
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ textWrap: 'clip' }); setWrapOpen(false); }}>{t.projects.table.wrapClip}</Button>
          </PopoverContent>
        </Popover>

        {/* Text rotation */}
        <Popover open={rotationOpen} onOpenChange={setRotationOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0" style={TB} title={t.projects.table.rotationTitle}>
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-36 p-1" align="start">
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ textRotation: 0 }); setRotationOpen(false); }}>{t.projects.table.rotateNone}</Button>
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ textRotation: 45 }); setRotationOpen(false); }}>{t.projects.table.rotateTiltUp}</Button>
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ textRotation: -45 }); setRotationOpen(false); }}>{t.projects.table.rotateTiltDown}</Button>
            <Button variant="ghost" size="sm" className="w-full justify-start text-xs h-7" onClick={() => { onFormat({ textRotation: 90 }); setRotationOpen(false); }}>{t.projects.table.rotateUp}</Button>
          </PopoverContent>
        </Popover>

        <Sep />

        {/* Link / Comment / Function */}
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={onInsertLink} title={t.projects.table.linkTitle}>
          <Link className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={onComment} title={t.projects.table.commentTitle}>
          <MessageSquare className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="p-0" style={TB} onClick={onInsertFunction} title={t.projects.table.formulaTitle}>
          <SquareFunction className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className={`p-0 ${showFormulaBar ? 'bg-accent' : ''}`} style={TB} onClick={onToggleFormulaBar} title={t.projects.table.formulaBarTitle}>
          <span className="text-sm italic font-semibold">fx</span>
        </Button>

        {/* Zoom (right side) */}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoomChange(Math.max(50, zoom - 25))} disabled={zoom <= 50} title={t.projects.table.decreaseFontTitle}>
            <Minus className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">{zoom}%</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onZoomChange(Math.min(200, zoom + 25))} disabled={zoom >= 200} title={t.projects.table.increaseFontTitle}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Status Bar ---
function StatusBar({ columns, rows, selBounds }: {
  columns: { id: string; position: number }[];
  rows: { id: string; position: number; data: Record<string, CellDataValue> }[];
  selBounds: { minCol: number; maxCol: number; minRow: number; maxRow: number } | null;
}) {
  const stats = useMemo(() => {
    if (!selBounds) return null;
    const sortedCols = [...columns].sort((a, b) => a.position - b.position);
    const rowMap = new Map(rows.map(r => [r.position, r]));
    let sum = 0, count = 0, numCount = 0;
    for (let r = selBounds.minRow; r <= selBounds.maxRow; r++) {
      for (let c = selBounds.minCol; c <= selBounds.maxCol; c++) {
        const br = rowMap.get(r); const bc = sortedCols[c];
        if (!br || !bc) continue;
        const val = br.data?.[bc.id];
        if (val !== null && val !== undefined && val !== '') {
          count++;
          const n = Number(val);
          if (!isNaN(n)) { sum += n; numCount++; }
        }
      }
    }
    if (count === 0) return null;
    const avg = numCount > 0 ? sum / numCount : null;
    return { sum, avg, count };
  }, [columns, rows, selBounds]);

  if (!stats) return null;

  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground px-3">
      {stats.avg !== null && <span>Average: {stats.avg.toFixed(2)}</span>}
      <span>Count: {stats.count}</span>
      {stats.avg !== null && <span>Sum: {stats.sum.toFixed(2)}</span>}
    </div>
  );
}

// --- Main SpreadsheetView ---
interface SpreadsheetViewProps {
  projectId: string;
  tableId: string;
  tableName?: string;
  onBack: () => void;
}

export function SpreadsheetView({ projectId, tableId, tableName, onBack }: SpreadsheetViewProps) {
  const { t } = useI18n();
  const {
    sheets,
    columns,
    rows,
    activeSheetId,
    setActiveSheetId,
    isLoadingSheets,
    isLoadingColumns,
    createSheet,
    updateSheet,
    deleteSheet,
    createColumn,
    updateColumn,
    createRow,
    updateRow,
    deleteRow,
    bulkDeleteRows,
    duplicateSheet,
    reorderSheets,
    insertRowAt,
    deleteRowAt,
    insertColumnAt,
    deleteColumnAt,
    shiftCellsVertical,
    shiftCellsHorizontal,
    updateSheetSettings,
    activeSheetSettings,
  } = useSpreadsheet(projectId, tableId);

  // Lifted selection state for formula bar sync
  const [selectedCell, setSelectedCell] = useState<CellCoord | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<CellCoord | null>(null);
  const [editValue, setEditValue] = useState('');
  const [inlineSelection, setInlineSelection] = useState<{ start: number; end: number } | null>(null);
  const editingRunsRef = useRef<RichTextRun[]>([]);
  const [isEditing, setIsEditing] = useState(false);
  const [showFormulaBar, setShowFormulaBar] = useState(false);
  const [zoom, setZoom] = useState(100);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    type: 'cell' | 'column-header' | 'row-number';
    coord: CellCoord;
    x: number;
    y: number;
  } | null>(null);

  // Column-filter popover (anchored at the clicked header funnel)
  const [filterMenu, setFilterMenu] = useState<{ colIndex: number; x: number; y: number } | null>(null);

  // Insert-link / insert-note dialogs
  const [linkDialog, setLinkDialog] = useState<{ col: number; row: number; text: string; url: string } | null>(null);
  const [noteDialog, setNoteDialog] = useState<{ col: number; row: number; text: string } | null>(null);
  // Dropdown (data-validation list) editor — options apply to the whole column.
  const [dropdownDialog, setDropdownDialog] = useState<{ colId: string; colName: string; optionsText: string } | null>(null);

  // Grid clipboard actions, used by the context menu
  const clipboardApiRef = useRef<SpreadsheetClipboardApi | null>(null);

  // Undo/redo stacks
  const [undoStack, setUndoStack] = useState<Array<{ undo: () => Promise<void>; redo: () => Promise<void> }>>([]);
  const [redoStack, setRedoStack] = useState<Array<{ undo: () => Promise<void>; redo: () => Promise<void> }>>([]);
  const [paintFormat, setPaintFormat] = useState<CellFormat | null>(null);

  // Reset selection when switching sheets
  useEffect(() => {
    setSelectedCell(null);
    setSelectionEnd(null);
    setEditValue('');
    setIsEditing(false);
  }, [activeSheetId]);

  const handleUpdateRow = useCallback(async (rowId: string, data: Record<string, CellDataValue>) => {
    return updateRow.mutateAsync({ rowId, data: { data } });
  }, [updateRow]);

  const handleDeleteRow = useCallback(async (rowId: string) => {
    return deleteRow.mutateAsync(rowId);
  }, [deleteRow]);

  const handleBulkDeleteRows = useCallback(async (ids: string[]) => {
    return bulkDeleteRows.mutateAsync(ids);
  }, [bulkDeleteRows]);

  const handleCreateRow = useCallback((initialData?: { data?: Record<string, CellDataValue>; position?: number }) => {
    createRow.mutate(initialData);
  }, [createRow]);

  const handleCreateColumn = useCallback((data: { name: string; fieldType: string; options?: string[] }) => {
    createColumn.mutate({ name: data.name, fieldType: data.fieldType, options: data.options });
  }, [createColumn]);

  const handleUpdateColumn = useCallback((colId: string, data: { name?: string; width?: number }) => {
    updateColumn.mutate({ colId, data });
  }, [updateColumn]);

  const handleRenameSheet = useCallback((sheetId: string, name: string) => {
    updateSheet.mutate({ sheetId, data: { name } });
  }, [updateSheet]);

  const handleDuplicateSheet = useCallback((sheetId: string, name: string) => {
    duplicateSheet.mutate({ sheetId, name });
  }, [duplicateSheet]);

  const handleReorderSheets = useCallback((sheetIds: string[]) => {
    reorderSheets.mutate(sheetIds);
  }, [reorderSheets]);

  // Format cells — applies format to given cells
  const applyFormat = useCallback((cells: Array<{ rowId: string; colId: string }>, format: Partial<CellFormat>) => {
    const rowMap = new Map(rows.map(r => [r.id, r]));
    for (const { rowId, colId } of cells) {
      const row = rowMap.get(rowId);
      if (!row) continue;
      const existing = getCellFormat(row.data, colId);
      const updates: Partial<CellFormat> = {};
      for (const key of Object.keys(format) as (keyof CellFormat)[]) {
        const value = format[key];
        if (typeof value === 'boolean' && (key === 'bold' || key === 'italic' || key === 'strikethrough')) {
          updates[key] = !existing?.[key];
        } else if (key === 'decimalPlaces' && (value === -1 || value === 1)) {
          const current = existing?.decimalPlaces ?? 2;
          updates.decimalPlaces = Math.max(0, Math.min(10, current + value));
        } else if (key === 'border' && value === 'none') {
          updates.border = undefined;
        } else {
          setFormatKey(updates, key, value);
        }
      }
      const merged = mergeFormat(existing, updates);
      updateRow.mutate({ rowId, data: { data: { [formatKey(colId)]: merged } } });
    }
  }, [rows, updateRow]);

  // Toolbar format handler — supports both cell-level and inline rich text formatting
  const cellLevelKeys = useMemo(() => new Set(['fillColor','textAlign','verticalAlign','numberFormat','decimalPlaces','currencySymbol','border','merge','textWrap','textRotation']), []);

  const handleToolbarFormat = useCallback((format: Partial<CellFormat>) => {
    if (!selectedCell) return;

    const isCellLevel = Object.keys(format).some(k => cellLevelKeys.has(k));

    // If editing and format is inline (bold/italic/etc), apply to text selection
    if (isEditing && !isCellLevel) {
      const gridEl = document.querySelector('[data-col][data-row] [contenteditable]') as HTMLDivElement | null;

      // Get current selection from the contentEditable directly
      const sel = gridEl ? saveSelection(gridEl) : inlineSelection;
      if (!sel) return;

      const runs = editingRunsRef.current.length > 0
        ? editingRunsRef.current
        : runsFromPlainText(editValue);

      const { start, end } = sel;

      // For boolean toggles, check if selection is already formatted
      const inlineFormat: Partial<RichTextRun> = {};
      for (const key of Object.keys(format) as (keyof CellFormat)[]) {
        if (key === 'bold') {
          inlineFormat.bold = !isAllBold(runs, start, end);
        } else if (key === 'italic') {
          inlineFormat.italic = !isAllItalic(runs, start, end);
        } else if (key === 'strikethrough') {
          inlineFormat.strikethrough = !isAllStrikethrough(runs, start, end);
        } else if (key === 'textColor') {
          inlineFormat.textColor = format.textColor;
        } else if (key === 'fontFamily') {
          inlineFormat.fontFamily = format.fontFamily;
        } else if (key === 'fontSize') {
          inlineFormat.fontSize = format.fontSize;
        }
      }

      // If cursor is collapsed (no selection), apply format via execCommand so the browser
      // handles it for the next typed characters natively
      if (start === end && gridEl) {
        if (format.bold !== undefined) document.execCommand('bold');
        if (format.italic !== undefined) document.execCommand('italic');
        if (format.strikethrough !== undefined) document.execCommand('strikeThrough');
        // Read back the new HTML
        const newRuns = htmlToRuns(gridEl.innerHTML);
        editingRunsRef.current = newRuns;
        setEditValue(plainTextFromRuns(newRuns));
        return;
      }

      const newRuns = applyFormatToRange(runs, start, end, inlineFormat);
      editingRunsRef.current = newRuns;

      // Update the contentEditable with new HTML and restore selection
      if (gridEl) {
        const html = runsToHtml(newRuns);
        gridEl.innerHTML = html;
        restoreSelection(gridEl, { start, end });
        // Read back to normalize
        const finalRuns = htmlToRuns(gridEl.innerHTML);
        editingRunsRef.current = finalRuns;
      }

      setEditValue(plainTextFromRuns(newRuns));
      return;
    }

    // Cell-level formatting path
    const end = selectionEnd ?? selectedCell;
    const sel = normRange({ start: selectedCell, end });
    const sortedCols = [...columns].sort((a, b) => a.position - b.position);
    const positionMap = new Map(rows.map(r => [r.position, r]));

    const cells: Array<{ rowId: string; colId: string }> = [];
    for (let r = sel.minRow; r <= sel.maxRow; r++) {
      for (let c = sel.minCol; c <= sel.maxCol; c++) {
        const row = positionMap.get(r);
        const col = sortedCols[c];
        if (row && col) {
          cells.push({ rowId: row.id, colId: col.id });
        } else if (!row && col) {
          createRow.mutate({ data: { [formatKey(col.id)]: format }, position: r });
        }
      }
    }

    if (cells.length > 0) applyFormat(cells, format);
  }, [selectedCell, selectionEnd, columns, rows, applyFormat, createRow, isEditing, inlineSelection, editValue, cellLevelKeys]);

  // Keep old name for context menu and paint format usage
  const handleFormatCells = applyFormat;

  const handlePaintFormat = useCallback(() => {
    if (paintFormat) {
      setPaintFormat(null);
      return;
    }
    if (!selectedCell) return;
    const sortedCols = [...columns].sort((a, b) => a.position - b.position);
    const rowMap = new Map(rows.map(r => [r.position, r]));
    const br = rowMap.get(selectedCell.row);
    const bc = sortedCols[selectedCell.col];
    if (!br || !bc) return;
    const fmt = getCellFormat(br.data, bc.id);
    setPaintFormat(fmt || {});
  }, [paintFormat, selectedCell, columns, rows]);

  useEffect(() => {
    if (!paintFormat || !selectedCell) return;
    const sel = normRange({ start: selectedCell, end: selectionEnd ?? selectedCell });
    const sortedCols = [...columns].sort((a, b) => a.position - b.position);
    const rowMap = new Map(rows.map(r => [r.position, r]));
    const cells: Array<{ rowId: string; colId: string }> = [];
    for (let r = sel.minRow; r <= sel.maxRow; r++) {
      for (let c = sel.minCol; c <= sel.maxCol; c++) {
        const br = rowMap.get(r); const bc = sortedCols[c];
        if (br && bc) cells.push({ rowId: br.id, colId: bc.id });
      }
    }
    if (cells.length > 0) {
      for (const { rowId, colId } of cells) {
        const merged = mergeFormat(getCellFormat(rows.find(r => r.id === rowId)?.data, colId), paintFormat);
        updateRow.mutate({ rowId, data: { data: { [formatKey(colId)]: merged } } });
      }
    }
    setPaintFormat(null);
    // Intentionally scoped to `selectedCell` only: this must fire exactly once, on the
    // click that picks the *target* cell after format-painter activation. Adding
    // `paintFormat` (or `rows`/`columns`/`updateRow`, which change as a result of the
    // mutate() below) would also re-run this on activation itself — immediately
    // re-applying to the source cell and cancelling painter mode before the user can
    // pick a target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCell]);

  const handleContextMenu = useCallback((e: React.MouseEvent, type: 'cell' | 'column-header' | 'row-number', coord: CellCoord) => {
    setContextMenu({ type, coord, x: e.clientX, y: e.clientY });
  }, []);

  // Largest occupied row position — used to size the "used range" for
  // Convert-to-table / Create-filter when there is no multi-cell selection.
  const maxRowPos = useMemo(
    () => rows.reduce((acc, r) => Math.max(acc, r.position), -1),
    [rows],
  );

  // The range an action operates on: the current selection, or — when only a
  // single cell is selected — the cell the menu was opened on.
  const getOpRange = useCallback(() => {
    if (selectedCell) {
      return normRange({ start: selectedCell, end: selectionEnd ?? selectedCell });
    }
    const c = contextMenu?.coord;
    if (c) return { minCol: c.col, maxCol: c.col, minRow: c.row, maxRow: c.row };
    return null;
  }, [selectedCell, selectionEnd, contextMenu]);

  // --- Row/column structural handlers (position-aware) ------------------
  const handleInsertRowAbove = useCallback((rowIdx: number) => {
    insertRowAt.mutate({ position: rowIdx });
    setContextMenu(null);
  }, [insertRowAt]);

  const handleInsertRowBelow = useCallback((rowIdx: number) => {
    insertRowAt.mutate({ position: rowIdx + 1 });
    setContextMenu(null);
  }, [insertRowAt]);

  const handleDeleteRowCtx = useCallback((rowIdx: number) => {
    deleteRowAt.mutate({ position: rowIdx });
    setContextMenu(null);
  }, [deleteRowAt]);

  const handleInsertColLeft = useCallback((colIdx: number) => {
    insertColumnAt.mutate({ index: colIdx, name: `Column ${columns.length + 1}` });
    setContextMenu(null);
  }, [columns.length, insertColumnAt]);

  const handleInsertColRight = useCallback((colIdx: number) => {
    insertColumnAt.mutate({ index: colIdx + 1, name: `Column ${columns.length + 1}` });
    setContextMenu(null);
  }, [columns.length, insertColumnAt]);

  const handleDeleteColCtx = useCallback((colIdx: number) => {
    deleteColumnAt.mutate({ index: colIdx });
    setContextMenu(null);
  }, [deleteColumnAt]);

  // --- Insert / delete cells (shift) ------------------------------------
  const handleInsertCellsShiftDown = useCallback(() => {
    const r = getOpRange();
    if (!r) return;
    const colIds = columns.slice(r.minCol, r.maxCol + 1).map((c) => c.id);
    shiftCellsVertical.mutate({ colIds, anchorPos: r.minRow, count: r.maxRow - r.minRow + 1, mode: 'insert' });
    setContextMenu(null);
  }, [getOpRange, columns, shiftCellsVertical]);

  const handleDeleteCellsShiftUp = useCallback(() => {
    const r = getOpRange();
    if (!r) return;
    const colIds = columns.slice(r.minCol, r.maxCol + 1).map((c) => c.id);
    shiftCellsVertical.mutate({ colIds, anchorPos: r.minRow, count: r.maxRow - r.minRow + 1, mode: 'delete' });
    setContextMenu(null);
  }, [getOpRange, columns, shiftCellsVertical]);

  const handleInsertCellsShiftRight = useCallback(() => {
    const r = getOpRange();
    if (!r) return;
    shiftCellsHorizontal.mutate({
      orderedColIds: columns.map((c) => c.id),
      anchorIndex: r.minCol,
      count: r.maxCol - r.minCol + 1,
      minRow: r.minRow,
      maxRow: r.maxRow,
      mode: 'insert',
    });
    setContextMenu(null);
  }, [getOpRange, columns, shiftCellsHorizontal]);

  const handleDeleteCellsShiftLeft = useCallback(() => {
    const r = getOpRange();
    if (!r) return;
    shiftCellsHorizontal.mutate({
      orderedColIds: columns.map((c) => c.id),
      anchorIndex: r.minCol,
      count: r.maxCol - r.minCol + 1,
      minRow: r.minRow,
      maxRow: r.maxRow,
      mode: 'delete',
    });
    setContextMenu(null);
  }, [getOpRange, columns, shiftCellsHorizontal]);

  // Write a value / link / note onto a single cell (creates the row if needed).
  const writeCellExtras = useCallback(
    (col: number, row: number, extras: { value?: string; link?: string | null; note?: string | null }) => {
      const colObj = columns[col];
      if (!colObj) return;
      const data: Record<string, CellDataValue> = {};
      if (extras.value !== undefined) data[colObj.id] = extras.value || null;
      if (extras.link !== undefined) data[linkKey(colObj.id)] = extras.link || null;
      if (extras.note !== undefined) data[noteKey(colObj.id)] = extras.note || null;
      const rowObj = rows.find((r) => r.position === row);
      if (rowObj) updateRow.mutate({ rowId: rowObj.id, data: { data } });
      else createRow.mutate({ data, position: row });
    },
    [columns, rows, updateRow, createRow],
  );

  // --- Convert to table: style header + band rows, enable a filter -------
  const handleConvertToTable = useCallback(() => {
    let range = getOpRange();
    if (!range || (range.minCol === range.maxCol && range.minRow === range.maxRow)) {
      range = { minCol: 0, maxCol: Math.max(0, columns.length - 1), minRow: 0, maxRow: Math.max(0, maxRowPos) };
    }
    const posMap = new Map(rows.map((r) => [r.position, r]));
    for (let rr = range.minRow; rr <= range.maxRow; rr++) {
      const isHeader = rr === range.minRow;
      for (let cc = range.minCol; cc <= range.maxCol; cc++) {
        const col = columns[cc];
        if (!col) continue;
        const fmt: Partial<CellFormat> = isHeader
          ? { bold: true, fillColor: '#1a73e826', textColor: '#1a3d7c' }
          : (rr - range.minRow) % 2 === 0
            ? { fillColor: '#00000008' }
            : { fillColor: undefined };
        const rowObj = posMap.get(rr);
        if (rowObj) {
          const merged = mergeFormat(getCellFormat(rowObj.data, col.id), fmt);
          updateRow.mutate({ rowId: rowObj.id, data: { data: { [formatKey(col.id)]: merged } } });
        } else if (isHeader || fmt.fillColor) {
          createRow.mutate({ data: { [formatKey(col.id)]: fmt }, position: rr });
        }
      }
    }
    if (activeSheetId) {
      updateSheetSettings.mutate({
        sheetId: activeSheetId,
        settings: {
          table: { headerRow: range.minRow, ...range },
          filter: { active: true, headerRow: range.minRow, ...range, criteria: {} },
        },
      });
    }
    toast.success(t.projects.table.convertedToTable);
    setContextMenu(null);
  }, [getOpRange, columns, rows, maxRowPos, activeSheetId, updateRow, createRow, updateSheetSettings, t]);

  // --- Create / remove a column filter ----------------------------------
  const handleCreateFilter = useCallback(() => {
    if (!activeSheetId) return;
    const existing = activeSheetSettings?.filter;
    if (existing?.active) {
      updateSheetSettings.mutate({ sheetId: activeSheetId, settings: { filter: { ...existing, active: false } } });
      toast.success(t.projects.table.filterRemoved);
    } else {
      let range = getOpRange();
      if (!range || (range.minCol === range.maxCol && range.minRow === range.maxRow)) {
        range = { minCol: 0, maxCol: Math.max(0, columns.length - 1), minRow: 0, maxRow: Math.max(0, maxRowPos) };
      }
      updateSheetSettings.mutate({
        sheetId: activeSheetId,
        settings: { filter: { active: true, headerRow: range.minRow, ...range, criteria: {} } },
      });
      toast.success(t.projects.table.filterCreated);
    }
    setContextMenu(null);
  }, [activeSheetId, activeSheetSettings, getOpRange, columns.length, maxRowPos, updateSheetSettings, t]);

  // --- Insert link / note (open the dialogs) ----------------------------
  const handleInsertLink = useCallback(() => {
    const cell = selectedCell ?? contextMenu?.coord;
    if (!cell) return;
    const col = columns[cell.col];
    const rowObj = rows.find((r) => r.position === cell.row);
    const text = (col && rowObj?.data?.[col.id]?.toString()) || '';
    const url = (col && rowObj && getCellLink(rowObj.data, col.id)) || '';
    setLinkDialog({ col: cell.col, row: cell.row, text, url });
    setContextMenu(null);
  }, [selectedCell, contextMenu, columns, rows]);

  const handleInsertNote = useCallback(() => {
    const cell = selectedCell ?? contextMenu?.coord;
    if (!cell) return;
    const col = columns[cell.col];
    const rowObj = rows.find((r) => r.position === cell.row);
    const text = (col && rowObj && getCellNote(rowObj.data, col.id)) || '';
    setNoteDialog({ col: cell.col, row: cell.row, text });
    setContextMenu(null);
  }, [selectedCell, contextMenu, columns, rows]);

  // Open the dropdown editor for the column under the selection / right-click.
  const handleDropdownChip = useCallback(() => {
    const cell = selectedCell ?? contextMenu?.coord;
    if (!cell) return;
    const col = columns[cell.col];
    if (!col) {
      toast.error(t.projects.table.dropdownNeedsColumn);
      setContextMenu(null);
      return;
    }
    const existing = Array.isArray(col.options) ? (col.options as string[]) : [];
    setDropdownDialog({ colId: col.id, colName: col.name, optionsText: existing.join('\n') });
    setContextMenu(null);
  }, [selectedCell, contextMenu, columns, t]);

  const handleGetLinkToCell = useCallback(() => {
    const cell = selectedCell ?? contextMenu?.coord;
    if (!cell) return;
    const anchor = `${colLabel(cell.col)}${cell.row + 1}`;
    const url = `${window.location.origin}${window.location.pathname}${window.location.search}#cell=${anchor}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    toast.success(t.projects.table.cellLinkCopied);
    setContextMenu(null);
  }, [selectedCell, contextMenu, t]);

  const handleComingSoon = useCallback((feature: string) => {
    toast.info(`${feature} — ${t.projects.table.comingSoon}`);
    setContextMenu(null);
  }, [t]);

  // --- Merge / unmerge the current selection ----------------------------
  const handleMergeCells = useCallback(() => {
    if (!activeSheetId) return;
    const r = getOpRange();
    if (!r) return;
    const merges = (activeSheetSettings?.merges ?? []) as Array<{ minCol: number; maxCol: number; minRow: number; maxRow: number }>;
    const overlaps = (m: { minCol: number; maxCol: number; minRow: number; maxRow: number }) =>
      !(r.maxCol < m.minCol || r.minCol > m.maxCol || r.maxRow < m.minRow || r.minRow > m.maxRow);
    const overlapping = merges.filter(overlaps);
    let next: typeof merges;
    if (overlapping.length > 0) {
      next = merges.filter((m) => !overlapping.includes(m)); // unmerge
      toast.success(t.projects.table.cellsUnmerged);
    } else {
      if (r.minCol === r.maxCol && r.minRow === r.maxRow) return; // single cell — nothing to merge
      next = [...merges, { minCol: r.minCol, maxCol: r.maxCol, minRow: r.minRow, maxRow: r.maxRow }];
      toast.success(t.projects.table.cellsMerged);
    }
    updateSheetSettings.mutate({ sheetId: activeSheetId, settings: { merges: next } });
  }, [activeSheetId, getOpRange, activeSheetSettings, updateSheetSettings, t]);

  // --- Insert function: open the formula bar and start a formula ---------
  const handleInsertFunction = useCallback(() => {
    setShowFormulaBar(true);
    if (selectedCell) {
      editingRunsRef.current = [];
      setEditValue('=');
      setIsEditing(true);
    }
  }, [selectedCell]);

  const handleFormulaBarCommit = useCallback((value: string) => {
    if (!selectedCell) return;
    const sortedCols = [...columns].sort((a, b) => a.position - b.position);
    const bc = sortedCols[selectedCell.col];
    const br = rows.find(r => r.position === selectedCell.row);
    if (bc && br) {
      const old = br.data?.[bc.id]?.toString() ?? '';
      if (value !== old) {
        updateRow.mutate({ rowId: br.id, data: { data: { [bc.id]: value || null } } });
      }
    } else if (bc && !br && value) {
      createRow.mutate({ data: { [bc.id]: value }, position: selectedCell.row });
    }
    setIsEditing(false);
  }, [selectedCell, columns, rows, updateRow, createRow]);

  const handleFormulaBarCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const selBounds = useMemo(() => {
    if (!selectedCell) return null;
    return normRange({ start: selectedCell, end: selectionEnd ?? selectedCell });
  }, [selectedCell, selectionEnd]);

  const activeFormat = useMemo(() => {
    if (!selectedCell) return undefined;

    // When editing, derive format from inline selection within rich text runs
    if (isEditing && inlineSelection && editingRunsRef.current.length > 0) {
      const runs = editingRunsRef.current;
      const { start, end } = inlineSelection;
      return {
        bold: isAllBold(runs, start, end),
        italic: isAllItalic(runs, start, end),
        strikethrough: isAllStrikethrough(runs, start, end),
      } as CellFormat;
    }

    const sortedCols = [...columns].sort((a, b) => a.position - b.position);
    const bc = sortedCols[selectedCell.col];
    const br = rows.find(r => r.position === selectedCell.row);
    if (!br || !bc) return undefined;
    return getCellFormat(br.data, bc.id);
  }, [selectedCell, columns, rows, isEditing, inlineSelection]);

  // Active column filter (persisted in sheet settings) + the rows it hides.
  const activeFilter = activeSheetSettings?.filter?.active ? activeSheetSettings.filter : null;

  const hiddenRows = useMemo(() => {
    if (!activeFilter) return undefined;
    const crit = activeFilter.criteria ?? {};
    const colIds = Object.keys(crit);
    if (colIds.length === 0) return undefined;
    const hidden = new Set<number>();
    for (const row of rows) {
      if (row.position <= activeFilter.headerRow) continue;
      if (row.position < activeFilter.minRow || row.position > activeFilter.maxRow) continue;
      for (const colId of colIds) {
        const allowed = crit[colId];
        if (!allowed) continue;
        const val = (row.data?.[colId] ?? '').toString();
        if (!allowed.includes(val)) {
          hidden.add(row.position);
          break;
        }
      }
    }
    return hidden;
  }, [activeFilter, rows]);

  // Distinct values of a column within the filter range, for the filter popover.
  const filterColumnValues = useMemo(() => {
    if (!filterMenu || !activeFilter) return [];
    const col = columns[filterMenu.colIndex];
    if (!col) return [];
    const set = new Set<string>();
    for (const row of rows) {
      if (row.position <= activeFilter.headerRow) continue;
      if (row.position < activeFilter.minRow || row.position > activeFilter.maxRow) continue;
      set.add((row.data?.[col.id] ?? '').toString());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [filterMenu, activeFilter, columns, rows]);

  const handleApplyColumnFilter = useCallback((colIndex: number, allowed: string[] | null) => {
    if (!activeSheetId || !activeFilter) return;
    const col = columns[colIndex];
    if (!col) return;
    const criteria = { ...(activeFilter.criteria ?? {}) };
    if (allowed === null) delete criteria[col.id];
    else criteria[col.id] = allowed;
    updateSheetSettings.mutate({ sheetId: activeSheetId, settings: { filter: { ...activeFilter, criteria } } });
    setFilterMenu(null);
  }, [activeSheetId, activeFilter, columns, updateSheetSettings]);

  // Merged cell ranges + whether the current selection sits on one.
  const activeMerges = useMemo(() => activeSheetSettings?.merges ?? [], [activeSheetSettings]);
  const mergeActive = useMemo(() => {
    if (activeMerges.length === 0 || !selectedCell) return false;
    const r = normRange({ start: selectedCell, end: selectionEnd ?? selectedCell });
    return activeMerges.some(
      (m) => !(r.maxCol < m.minCol || r.minCol > m.maxCol || r.maxRow < m.minRow || r.minRow > m.maxRow),
    );
  }, [activeMerges, selectedCell, selectionEnd]);

  if (isLoadingSheets) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <SpreadsheetToolbar
        onBack={onBack}
        tableName={tableName}
        onFormat={handleToolbarFormat}
        onUndo={undoStack.length > 0 ? () => {
          const cmd = undoStack[undoStack.length - 1];
          setUndoStack(s => s.slice(0, -1));
          setRedoStack(s => [...s, cmd]);
          cmd.undo();
        } : undefined}
        onRedo={redoStack.length > 0 ? () => {
          const cmd = redoStack[redoStack.length - 1];
          setRedoStack(s => s.slice(0, -1));
          setUndoStack(s => [...s, cmd]);
          cmd.redo();
        } : undefined}
        canUndo={undoStack.length > 0}
        canRedo={redoStack.length > 0}
        paintFormatActive={!!paintFormat}
        onPaintFormat={handlePaintFormat}
        showFormulaBar={showFormulaBar}
        onToggleFormulaBar={() => setShowFormulaBar(prev => !prev)}
        zoom={zoom}
        onZoomChange={setZoom}
        activeFormat={activeFormat}
        onMergeCells={handleMergeCells}
        mergeActive={mergeActive}
        onInsertLink={handleInsertLink}
        onComment={() => handleComingSoon(t.projects.table.commentTitle)}
        onInsertFunction={handleInsertFunction}
      />

      {showFormulaBar && (
        <FormulaBar
          selectedCell={selectedCell}
          cellValue={editValue}
          onCellValueChange={setEditValue}
          onCommit={handleFormulaBarCommit}
          onCancel={handleFormulaBarCancel}
        />
      )}

      <div className="flex-1 overflow-hidden" style={{ zoom: zoom / 100 }}>
        {activeSheetId && !isLoadingColumns ? (
          <SpreadsheetGrid
            columns={columns}
            rows={rows}
            onUpdateRow={handleUpdateRow}
            onDeleteRow={handleDeleteRow}
            onBulkDeleteRows={handleBulkDeleteRows}
            onCreateRow={handleCreateRow}
            onCreateColumn={handleCreateColumn}
            onUpdateColumn={handleUpdateColumn}
            onFormatCells={handleFormatCells}
            selectedCell={selectedCell}
            onSelectedCellChange={setSelectedCell}
            editValue={editValue}
            onEditValueChange={setEditValue}
            isEditing={isEditing}
            onIsEditingChange={setIsEditing}
            selectionEnd={selectionEnd}
            onSelectionEndChange={setSelectionEnd}
            onContextMenu={handleContextMenu}
            onInlineSelectionChange={setInlineSelection}
            editingRuns={editingRunsRef}
            clipboardApiRef={clipboardApiRef}
            hiddenRows={hiddenRows}
            filter={activeFilter}
            onFilterClick={(colIndex, rect) => setFilterMenu({ colIndex, x: rect.left, y: rect.bottom + 4 })}
            merges={activeMerges}
          />
        ) : (
          <PageLoader fullScreen={false} />
        )}
      </div>

      <div className="flex items-center border-t bg-muted/30">
        <SheetTabBar
          sheets={sheets}
          activeSheetId={activeSheetId}
          onSelectSheet={setActiveSheetId}
          onCreateSheet={(name) => createSheet.mutate(name)}
          onRenameSheet={handleRenameSheet}
          onDeleteSheet={(id) => deleteSheet.mutate(id)}
          onDuplicateSheet={handleDuplicateSheet}
          onReorderSheets={handleReorderSheets}
        />
        <StatusBar columns={columns} rows={rows} selBounds={selBounds} />
      </div>

      {contextMenu && (
        <SpreadsheetContextMenu
          type={contextMenu.type}
          coord={contextMenu.coord}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onCut={() => clipboardApiRef.current?.cut()}
          onCopy={() => clipboardApiRef.current?.copy()}
          onPaste={() => clipboardApiRef.current?.paste()}
          onPasteValuesOnly={() => clipboardApiRef.current?.pasteValuesOnly()}
          onPasteFormatOnly={() => clipboardApiRef.current?.pasteFormatOnly()}
          onPasteFormulaOnly={() => clipboardApiRef.current?.pasteFormulaOnly()}
          onPasteTransposed={() => clipboardApiRef.current?.pasteTransposed()}
          onInsertRowAbove={handleInsertRowAbove}
          onInsertRowBelow={handleInsertRowBelow}
          onDeleteRow={handleDeleteRowCtx}
          onInsertColumnLeft={handleInsertColLeft}
          onInsertColumnRight={handleInsertColRight}
          onDeleteColumn={handleDeleteColCtx}
          onInsertCellsShiftRight={handleInsertCellsShiftRight}
          onInsertCellsShiftDown={handleInsertCellsShiftDown}
          onDeleteCellsShiftLeft={handleDeleteCellsShiftLeft}
          onDeleteCellsShiftUp={handleDeleteCellsShiftUp}
          onConvertToTable={handleConvertToTable}
          onCreateFilter={handleCreateFilter}
          onInsertLink={handleInsertLink}
          onInsertNote={handleInsertNote}
          onGetLinkToCell={handleGetLinkToCell}
          onDropdownChip={handleDropdownChip}
          onComingSoon={handleComingSoon}
        />
      )}

      {filterMenu && activeFilter && (
        <ColumnFilterPopover
          x={filterMenu.x}
          y={filterMenu.y}
          columnName={columns[filterMenu.colIndex]?.name ?? colLabel(filterMenu.colIndex)}
          values={filterColumnValues}
          allowed={activeFilter.criteria?.[columns[filterMenu.colIndex]?.id ?? ''] ?? null}
          onApply={(allowed) => handleApplyColumnFilter(filterMenu.colIndex, allowed)}
          onClose={() => setFilterMenu(null)}
        />
      )}

      {/* Insert link dialog */}
      <Dialog open={!!linkDialog} onOpenChange={(o) => { if (!o) setLinkDialog(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.table.insertLinkTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="sheet-link-text">{t.projects.table.linkTextLabel}</Label>
              <Input
                id="sheet-link-text"
                value={linkDialog?.text ?? ''}
                onChange={(e) => setLinkDialog((d) => (d ? { ...d, text: e.target.value } : d))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sheet-link-url">{t.projects.table.linkUrlLabel}</Label>
              <Input
                id="sheet-link-url"
                placeholder="https://..."
                value={linkDialog?.url ?? ''}
                onChange={(e) => setLinkDialog((d) => (d ? { ...d, url: e.target.value } : d))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkDialog(null)}>{t.projects.table.cancelBtn}</Button>
            <Button
              disabled={!linkDialog?.url?.trim()}
              onClick={() => {
                if (!linkDialog) return;
                const url = linkDialog.url.trim();
                writeCellExtras(linkDialog.col, linkDialog.row, { value: linkDialog.text.trim() || url, link: url });
                setLinkDialog(null);
                toast.success(t.projects.table.linkInserted);
              }}
            >
              {t.projects.table.insertLinkBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Insert note dialog */}
      <Dialog open={!!noteDialog} onOpenChange={(o) => { if (!o) setNoteDialog(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.table.insertNoteTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="sheet-note-text">{t.projects.table.noteLabel}</Label>
            <textarea
              id="sheet-note-text"
              rows={4}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={noteDialog?.text ?? ''}
              onChange={(e) => setNoteDialog((d) => (d ? { ...d, text: e.target.value } : d))}
            />
          </div>
          <DialogFooter>
            {noteDialog?.text ? (
              <Button
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive"
                onClick={() => {
                  if (!noteDialog) return;
                  writeCellExtras(noteDialog.col, noteDialog.row, { note: null });
                  setNoteDialog(null);
                  toast.success(t.projects.table.noteRemoved);
                }}
              >
                {t.projects.table.removeNote}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setNoteDialog(null)}>{t.projects.table.cancelBtn}</Button>
            <Button
              onClick={() => {
                if (!noteDialog) return;
                writeCellExtras(noteDialog.col, noteDialog.row, { note: noteDialog.text.trim() || null });
                setNoteDialog(null);
                toast.success(t.projects.table.noteSaved);
              }}
            >
              {t.projects.table.saveNoteBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dropdown (data-validation list) editor */}
      <Dialog open={!!dropdownDialog} onOpenChange={(o) => { if (!o) setDropdownDialog(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t.projects.table.dropdownDialogTitle}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="sheet-dropdown-options">
              {t.projects.table.dropdownOptionsLabel}
              {dropdownDialog ? <span className="ml-1 text-muted-foreground">· {dropdownDialog.colName}</span> : null}
            </Label>
            <textarea
              id="sheet-dropdown-options"
              rows={6}
              placeholder={t.projects.table.dropdownOptionsPlaceholder}
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={dropdownDialog?.optionsText ?? ''}
              onChange={(e) => setDropdownDialog((d) => (d ? { ...d, optionsText: e.target.value } : d))}
            />
            <p className="text-xs text-muted-foreground">{t.projects.table.dropdownOptionsHint}</p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              className="mr-auto text-destructive hover:text-destructive"
              onClick={() => {
                if (!dropdownDialog) return;
                updateColumn.mutate({ colId: dropdownDialog.colId, data: { fieldType: 'text', options: null } });
                setDropdownDialog(null);
                toast.success(t.projects.table.dropdownRemoved);
              }}
            >
              {t.projects.table.dropdownRemove}
            </Button>
            <Button variant="outline" onClick={() => setDropdownDialog(null)}>{t.projects.table.cancelBtn}</Button>
            <Button
              onClick={() => {
                if (!dropdownDialog) return;
                const options = dropdownDialog.optionsText
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean);
                if (options.length === 0) {
                  updateColumn.mutate({ colId: dropdownDialog.colId, data: { fieldType: 'text', options: null } });
                } else {
                  updateColumn.mutate({ colId: dropdownDialog.colId, data: { fieldType: 'select', options } });
                }
                setDropdownDialog(null);
                toast.success(t.projects.table.dropdownSaved);
              }}
            >
              {t.projects.table.saveBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --- Column filter popover --------------------------------------------------
interface ColumnFilterPopoverProps {
  x: number;
  y: number;
  columnName: string;
  values: string[];
  allowed: string[] | null;
  onApply: (allowed: string[] | null) => void;
  onClose: () => void;
}

function ColumnFilterPopover({ x, y, columnName, values, allowed, onApply, onClose }: ColumnFilterPopoverProps) {
  const { t } = useI18n();
  const [checked, setChecked] = useState<Set<string>>(() => new Set(allowed ?? values));

  const toggle = (v: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const apply = () => {
    // All selected → no constraint for this column.
    if (checked.size === values.length) onApply(null);
    else onApply(Array.from(checked));
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        className="fixed z-50 w-64 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
        style={{ left: Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 270), top: y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-1 truncate px-1 text-xs font-medium text-muted-foreground" title={columnName}>
          {columnName}
        </div>
        <div className="mb-2 flex items-center gap-2 px-1 text-xs">
          <Button variant="link" className="text-blue-600 hover:underline h-auto p-0 text-xs" onClick={() => setChecked(new Set(values))}>
            {t.projects.table.filterSelectAll}
          </Button>
          <span className="text-muted-foreground">·</span>
          <Button variant="link" className="text-blue-600 hover:underline h-auto p-0 text-xs" onClick={() => setChecked(new Set())}>
            {t.projects.table.filterClearSelection}
          </Button>
        </div>
        <div className="max-h-56 overflow-y-auto">
          {values.length === 0 ? (
            <div className="px-1 py-2 text-xs text-muted-foreground">{t.projects.table.filterNoValues}</div>
          ) : (
            values.map((v) => (
              <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent">
                <Checkbox checked={checked.has(v)} onCheckedChange={() => toggle(v)} className="h-3.5 w-3.5" />
                <span className="truncate">{v === '' ? t.projects.table.filterBlanks : v}</span>
              </label>
            ))
          )}
        </div>
        <div className="mt-2 flex justify-end gap-2 border-t pt-2">
          <Button variant="outline" size="sm" className="h-7" onClick={onClose}>
            {t.projects.table.cancelBtn}
          </Button>
          <Button size="sm" className="h-7" onClick={apply}>
            {t.projects.table.filterApply}
          </Button>
        </div>
      </div>
    </>
  );
}
