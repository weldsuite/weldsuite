/** Settings of the line-items table: a sortable column editor plus header, row and zebra styling. */
import { useId, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronRight, GripVertical } from 'lucide-react';
import {
  LINE_ITEM_COLUMNS,
  type BlockOf,
  type LineItemColumn,
  type LineItemColumnKey,
} from '@weldsuite/books-domain/invoice-template/schema';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useDesigner } from '../context';
import { mergeStyle } from '../model/colors';
import { ColorControl, Field, InspectorSection, Note, NumberInput, SwitchField } from './controls';
import type { Patch } from './block-panels';

/** Columns whose data the invoice decides: they print only when an invoice has it. */
const CONDITIONAL_COLUMNS: readonly LineItemColumnKey[] = ['unit', 'discount', 'hsnSac'];
const NEW_COLUMN_WIDTH = 10;

interface ColumnRowProps {
  column: LineItemColumn;
  name: string;
  canDisable: boolean;
  onChange: (patch: Partial<LineItemColumn> & { label?: string; align?: LineItemColumn['align'] }) => void;
  onDisable: () => void;
}

function ColumnRow({ column, name, canDisable, onChange, onDisable }: Readonly<ColumnRowProps>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.inspector.lineItems;
  const { readOnly } = useDesigner();
  const [open, setOpen] = useState(false);
  const id = useId();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: column.key, disabled: readOnly });
  const conditional = CONDITIONAL_COLUMNS.includes(column.key);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('rounded-md border border-border bg-background', isDragging && 'relative z-10 shadow-md')}
    >
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <button
          type="button"
          className="cursor-grab touch-none rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-default"
          aria-label={`${t.accounting.invoiceTemplates.layers.reorder}: ${name}`}
          disabled={readOnly}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <Checkbox
          checked
          disabled={readOnly || !canDisable}
          aria-label={`${tl.enable}: ${name}`}
          onCheckedChange={() => onDisable()}
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm outline-none"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="truncate">{column.label || name}</span>
          {conditional ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-label={tl.conditional} />
              </TooltipTrigger>
              <TooltipContent>{tl.conditional}</TooltipContent>
            </Tooltip>
          ) : null}
          <ChevronRight className={cn('ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
      </div>
      {open ? (
        <div id={id} className="grid grid-cols-2 gap-2 border-t border-border px-2 pb-2 pt-2">
          <Field label={tl.width}>
            <NumberInput value={column.width} min={0} max={100} step={1} onChange={(width) => onChange({ width })} />
          </Field>
          <Field label={tl.align}>
            <Select
              value={column.align ?? 'auto'}
              disabled={readOnly}
              onValueChange={(v) => onChange({ align: v === 'auto' ? undefined : (v as LineItemColumn['align']) })}
            >
              <SelectTrigger className="h-8 w-full text-sm" aria-label={tl.align}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t.accounting.invoiceTemplates.inspector.colors.none}</SelectItem>
                <SelectItem value="left">{t.accounting.invoiceTemplates.inspector.textStyle.alignLeft}</SelectItem>
                <SelectItem value="center">{t.accounting.invoiceTemplates.inspector.textStyle.alignCenter}</SelectItem>
                <SelectItem value="right">{t.accounting.invoiceTemplates.inspector.textStyle.alignRight}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={tl.label} className="col-span-2">
            <Input
              value={column.label ?? ''}
              maxLength={60}
              placeholder={name}
              disabled={readOnly}
              className="h-8 text-sm"
              onChange={(e) => onChange({ label: e.target.value === '' ? undefined : e.target.value })}
            />
          </Field>
        </div>
      ) : null}
    </li>
  );
}

function ColumnEditor({ block, update }: Readonly<{ block: BlockOf<'lineItems'>; update: (patch: Patch) => void }>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.inspector.lineItems;
  const { readOnly } = useDesigner();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const names = tl.columnNames as Record<LineItemColumnKey, string>;
  const enabled = new Set(block.columns.map((c) => c.key));
  const available = LINE_ITEM_COLUMNS.filter((key) => !enabled.has(key));

  const setColumns = (columns: LineItemColumn[]) => update({ columns });

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = block.columns.findIndex((c) => c.key === active.id);
    const to = block.columns.findIndex((c) => c.key === over.id);
    if (from < 0 || to < 0) return;
    setColumns(arrayMove(block.columns, from, to));
  };

  return (
    <div className="space-y-2">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={block.columns.map((c) => c.key)} strategy={verticalListSortingStrategy}>
          <ul className="space-y-1.5">
            {block.columns.map((column) => (
              <ColumnRow
                key={column.key}
                column={column}
                name={names[column.key]}
                canDisable={block.columns.length > 1}
                onChange={(patch) =>
                  setColumns(
                    block.columns.map((c) => {
                      if (c.key !== column.key) return c;
                      const next: Record<string, unknown> = { ...c, ...patch };
                      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
                      return next as unknown as LineItemColumn;
                    }),
                  )
                }
                onDisable={() => setColumns(block.columns.filter((c) => c.key !== column.key))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {available.length > 0 ? (
        <ul className="space-y-1 pt-1">
          {available.map((key) => (
            <li key={key} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-muted-foreground">
              <span className="w-5" />
              <Checkbox
                checked={false}
                disabled={readOnly || block.columns.length >= 12}
                aria-label={`${tl.enable}: ${names[key]}`}
                onCheckedChange={() => setColumns([...block.columns, { key, width: NEW_COLUMN_WIDTH }])}
              />
              <span className="truncate">{names[key]}</span>
              {CONDITIONAL_COLUMNS.includes(key) ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function LineItemsPanel({ block, update }: Readonly<{ block: BlockOf<'lineItems'>; update: (patch: Patch) => void }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates.inspector;
  const tl = ti.lineItems;
  const id = useId();
  const setHeader = (patch: Partial<NonNullable<typeof block.header>>) => update({ header: mergeStyle(block.header, patch as never) });

  return (
    <>
      <InspectorSection title={tl.columns}>
        <p className="text-[11px] leading-snug text-muted-foreground">{tl.columnsHint}</p>
        <ColumnEditor block={block} update={update} />
        <Field label={tl.fontSize} htmlFor={`${id}-size`}>
          <NumberInput
            id={`${id}-size`}
            value={block.fontSize}
            min={5}
            max={16}
            step={0.5}
            suffix="pt"
            placeholder="9"
            onChange={(n) => update({ fontSize: n })}
            onClear={() => update({ fontSize: undefined })}
          />
        </Field>
        <Note>{tl.note}</Note>
      </InspectorSection>

      <InspectorSection title={tl.header}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={tl.headerBackground}>
            <ColorControl value={block.header?.background} emptyLabel={ti.colors.none} onChange={(background) => setHeader({ background })} />
          </Field>
          <Field label={tl.headerColor}>
            <ColorControl
              value={block.header?.color}
              emptyLabel={ti.colors.default}
              emptyColor={block.header?.background ? 'text' : 'muted'}
              onChange={(color) => setHeader({ color })}
            />
          </Field>
        </div>
        <Field label={tl.headerRule}>
          <ColorControl
            value={block.header?.rule}
            emptyLabel={ti.colors.default}
            emptyColor={block.header?.background ? null : 'accent'}
            onChange={(rule) => setHeader({ rule })}
          />
        </Field>
        <Field label={ti.textStyle.size} htmlFor={`${id}-hsize`}>
          <NumberInput
            id={`${id}-hsize`}
            value={block.header?.fontSize}
            min={5}
            max={16}
            step={0.5}
            suffix="pt"
            onChange={(n) => setHeader({ fontSize: n })}
            onClear={() => setHeader({ fontSize: undefined })}
          />
        </Field>
        <SwitchField label={tl.headerBold} checked={block.header?.bold !== false} onChange={(v) => setHeader({ bold: v ? undefined : false })} />
        <SwitchField label={tl.headerUppercase} checked={block.header?.uppercase !== false} onChange={(v) => setHeader({ uppercase: v ? undefined : false })} />
      </InspectorSection>

      <InspectorSection title={tl.rows}>
        <Field label={tl.rowRule}>
          <ColorControl
            value={block.rowRule}
            emptyLabel={ti.colors.default}
            emptyColor="#e2e4e8"
            onChange={(rowRule) => update({ rowRule })}
          />
        </Field>
        <Field label={tl.zebra}>
          <ColorControl value={block.zebra} emptyLabel={ti.colors.none} onChange={(zebra) => update({ zebra })} />
        </Field>
        <Field label={tl.rowPadding} htmlFor={`${id}-pad`}>
          <NumberInput
            id={`${id}-pad`}
            value={block.rowPadding}
            min={0}
            max={16}
            step={0.5}
            suffix="pt"
            onChange={(n) => update({ rowPadding: n })}
            onClear={() => update({ rowPadding: undefined })}
          />
        </Field>
      </InspectorSection>
    </>
  );
}
