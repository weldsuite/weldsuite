/** The right-hand panel when blocks are selected: position, per-type settings, box and arrangement. */
import type { Dispatch } from 'react';
import { ArrowDown, ArrowUp, BringToFront, Copy, SendToBack, Trash2 } from 'lucide-react';
import type { BoxStyle, TemplateBlock, TemplateBlockType } from '@weldsuite/books-domain/invoice-template/schema';
import { Button } from '@weldsuite/ui/components/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { useDesigner } from '../context';
import { BLOCK_ICONS, blockLabel } from '../block-icons';
import { mergeStyle } from '../model/colors';
import type { ArrangeOp, EditorAction } from '../model/editor-reducer';
import {
  FieldPanel,
  ImagePanel,
  LegalPanel,
  LinePanel,
  LogoPanel,
  NotesPanel,
  PageNumberPanel,
  PartyPanel,
  PaymentPanel,
  RectPanel,
  TermsPanel,
  TextPanel,
  TotalsPanel,
  type Patch,
} from './block-panels';
import { ColorControl, Field, InspectorSection, NumberInput, SwitchField } from './controls';
import { LineItemsPanel } from './line-items-panel';

interface BlockInspectorProps {
  blocks: TemplateBlock[];
  dispatch: Dispatch<EditorAction>;
}

function PositionSection({ block, update }: Readonly<{ block: TemplateBlock; update: (patch: Patch) => void }>) {
  const { t } = useI18n();
  const tp = t.accounting.invoiceTemplates.inspector.position;
  const pt = t.accounting.invoiceTemplates.inspector.pt;
  const frozen = Boolean(block.locked);
  const isTable = block.type === 'lineItems';
  return (
    <InspectorSection title={tp.title}>
      <div className="grid grid-cols-2 gap-2">
        <Field label={tp.x}>
          <NumberInput value={block.x} min={-50} max={1000} suffix={pt} disabled={frozen} aria-label={tp.x} onChange={(x) => update({ x })} />
        </Field>
        <Field label={tp.y}>
          <NumberInput value={block.y} min={-50} max={1000} suffix={pt} disabled={frozen} aria-label={tp.y} onChange={(y) => update({ y })} />
        </Field>
        <Field label={tp.width}>
          <NumberInput value={block.w} min={2} max={1000} suffix={pt} disabled={frozen} aria-label={tp.width} onChange={(w) => update({ w })} />
        </Field>
        <Field label={tp.height}>
          <NumberInput value={block.h} min={0.5} max={1000} suffix={pt} disabled={frozen} aria-label={tp.height} onChange={(h) => update({ h })} />
        </Field>
      </div>
      <div className="space-y-2.5 pt-1">
        <SwitchField
          label={tp.everyPage}
          checked={Boolean(block.everyPage)}
          disabled={isTable}
          hint={isTable ? t.accounting.invoiceTemplates.inspector.lineItems.note : undefined}
          onChange={(v) => update({ everyPage: v || undefined })}
        />
        <SwitchField label={tp.hidden} checked={Boolean(block.hidden)} disabled={isTable} onChange={(v) => update({ hidden: v || undefined })} />
        <SwitchField label={tp.locked} checked={Boolean(block.locked)} onChange={(v) => update({ locked: v || undefined })} />
      </div>
    </InspectorSection>
  );
}

function BoxSection({ block, update }: Readonly<{ block: TemplateBlock; update: (patch: Patch) => void }>) {
  const { t } = useI18n();
  const tb = t.accounting.invoiceTemplates.inspector.box;
  const colors = t.accounting.invoiceTemplates.inspector.colors;
  const pt = t.accounting.invoiceTemplates.inspector.pt;
  const set = (patch: Partial<{ [K in keyof BoxStyle]: BoxStyle[K] | undefined }>) => update({ box: mergeStyle(block.box, patch) });
  return (
    <InspectorSection title={tb.title} defaultOpen={block.type === 'rect' || Boolean(block.box)}>
      <Field label={tb.background}>
        <ColorControl value={block.box?.background} emptyLabel={colors.none} onChange={(background) => set({ background })} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={tb.border}>
          <ColorControl value={block.box?.borderColor} emptyLabel={colors.none} onChange={(borderColor) => set({ borderColor })} />
        </Field>
        <Field label={tb.borderWidth}>
          <NumberInput
            value={block.box?.borderWidth}
            min={0}
            max={10}
            step={0.5}
            suffix={pt}
            placeholder="1"
            onChange={(borderWidth) => set({ borderWidth })}
            onClear={() => set({ borderWidth: undefined })}
          />
        </Field>
        <Field label={tb.radius}>
          <NumberInput
            value={block.box?.radius}
            min={0}
            max={40}
            suffix={pt}
            placeholder="0"
            onChange={(radius) => set({ radius })}
            onClear={() => set({ radius: undefined })}
          />
        </Field>
        <Field label={tb.padding}>
          <NumberInput
            value={block.box?.padding}
            min={0}
            max={40}
            suffix={pt}
            placeholder="0"
            onChange={(padding) => set({ padding })}
            onClear={() => set({ padding: undefined })}
          />
        </Field>
      </div>
    </InspectorSection>
  );
}

export function ArrangeSection({ ids, dispatch }: Readonly<{ ids: string[]; dispatch: Dispatch<EditorAction> }>) {
  const { t } = useI18n();
  const ta = t.accounting.invoiceTemplates.inspector.arrange;
  const { readOnly } = useDesigner();
  const items: Array<{ op: ArrangeOp; label: string; icon: typeof ArrowUp }> = [
    { op: 'forward', label: ta.forward, icon: ArrowUp },
    { op: 'backward', label: ta.backward, icon: ArrowDown },
    { op: 'front', label: ta.front, icon: BringToFront },
    { op: 'back', label: ta.back, icon: SendToBack },
  ];
  return (
    <InspectorSection title={ta.title}>
      <div className="grid grid-cols-4 gap-1.5">
        {items.map(({ op, label, icon: Icon }) => (
          <Tooltip key={op}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly}
                aria-label={label}
                className="shadow-none"
                onClick={() => dispatch({ type: 'arrange', ids, op })}
              >
                <Icon aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </InspectorSection>
  );
}

function TypePanel({ block, update }: Readonly<{ block: TemplateBlock; update: (patch: Patch) => void }>) {
  switch (block.type) {
    case 'text':
      return <TextPanel block={block} update={update} />;
    case 'field':
      return <FieldPanel block={block} update={update} />;
    case 'logo':
      return <LogoPanel block={block} update={update} />;
    case 'image':
      return <ImagePanel block={block} update={update} />;
    case 'seller':
    case 'billTo':
    case 'shipTo':
      return <PartyPanel block={block} update={update} />;
    case 'lineItems':
      return <LineItemsPanel block={block} update={update} />;
    case 'totals':
      return <TotalsPanel block={block} update={update} />;
    case 'payment':
      return <PaymentPanel block={block} update={update} />;
    case 'notes':
      return <NotesPanel block={block} update={update} />;
    case 'terms':
      return <TermsPanel block={block} update={update} />;
    case 'legal':
      return <LegalPanel block={block} update={update} />;
    case 'rect':
      return <RectPanel />;
    case 'line':
      return <LinePanel block={block} update={update} />;
    case 'pageNumber':
      return <PageNumberPanel block={block} update={update} />;
  }
}

/** Duplicate and delete: the table can do neither (a template has exactly one). */
function BlockActions({ ids, hasTable, dispatch }: Readonly<{ ids: string[]; hasTable: boolean; dispatch: Dispatch<EditorAction> }>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const { readOnly } = useDesigner();
  const single = ids.length === 1;
  const onlyTable = single && hasTable;
  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shadow-none"
        disabled={readOnly || onlyTable}
        onClick={() => dispatch({ type: 'duplicateBlocks', ids })}
      >
        <Copy aria-hidden />
        {ti.inspector.duplicate}
      </Button>
      {onlyTable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button type="button" variant="outline" size="sm" className="shadow-none" disabled>
                <Trash2 aria-hidden />
                {ti.inspector.delete}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60">{ti.canvas.cantDeleteTable}</TooltipContent>
        </Tooltip>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive shadow-none hover:text-destructive"
          disabled={readOnly}
          onClick={() => dispatch({ type: 'deleteBlocks', ids })}
        >
          <Trash2 aria-hidden />
          {single ? ti.inspector.delete : ti.inspector.multiDelete}
        </Button>
      )}
    </div>
  );
}

export function BlockInspector({ blocks, dispatch }: Readonly<BlockInspectorProps>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const { fieldNames } = useDesigner();
  const ids = blocks.map((b) => b.id);
  const hasTable = blocks.some((b) => b.type === 'lineItems');
  const names = ti.blocks as Record<TemplateBlockType, string>;

  if (blocks.length === 0) return null;

  if (blocks.length > 1) {
    return (
      <div>
        <div className="space-y-3 border-b border-border px-4 py-4">
          <h2 className="text-sm font-semibold">{ti.inspector.selectedCount.replace('{count}', String(blocks.length))}</h2>
          <p className="text-xs text-muted-foreground">{ti.inspector.multiHint}</p>
          <BlockActions ids={ids} hasTable={hasTable} dispatch={dispatch} />
        </div>
        <ArrangeSection ids={ids} dispatch={dispatch} />
      </div>
    );
  }

  const block = blocks[0];
  const Icon = BLOCK_ICONS[block.type];
  const update = (patch: Patch) =>
    dispatch({
      type: 'updateBlocks',
      ids: [block.id],
      update: patch,
      coalesce: `inspector:${block.id}:${Object.keys(patch).sort().join(',')}`,
    });

  return (
    <div>
      <div className="space-y-3 border-b border-border px-4 py-4">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{blockLabel(block, names, fieldNames)}</h2>
            <p className="text-xs text-muted-foreground">{names[block.type]}</p>
          </div>
        </div>
        <BlockActions ids={ids} hasTable={hasTable} dispatch={dispatch} />
      </div>
      <PositionSection block={block} update={update} />
      <TypePanel block={block} update={update} />
      {block.type !== 'line' ? <BoxSection block={block} update={update} /> : null}
      <ArrangeSection ids={ids} dispatch={dispatch} />
    </div>
  );
}
