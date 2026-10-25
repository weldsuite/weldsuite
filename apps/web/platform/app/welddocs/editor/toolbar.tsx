import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  Baseline,
  Bold,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Plus,
  Printer,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Underline,
  Undo2,
  UnfoldVertical,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { ColorButton, Divider, IconButton, Menu, Toggle } from './ui';

export const FONTS = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Courier New', 'Georgia', 'Garamond', 'Helvetica', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];
export const ZOOMS = [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2];
export const PARAGRAPH_STYLES = ['normal', 'title', 'subtitle', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'quote', 'code'] as const;
const LINE_HEIGHTS = [1, 1.15, 1.5, 2];

/** The row of formatting controls under the menus, as in Google Docs. */
export function Toolbar({ controller }: { controller: DocController }) {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  const { t } = useI18n();
  const tt = t.welddocs.toolbar;
  const ts = t.welddocs.styles;
  const ro = controller.readOnly;
  const style = controller.textStyle();
  const para = controller.paragraph();
  const paragraphStyle = controller.paragraphStyle();
  const align = para.align ?? 'left';

  return (
    <div className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto border-b bg-muted/30 px-2" role="toolbar" aria-label={t.welddocs.title}>
      <IconButton label={tt.undo} onClick={() => controller.undo()} disabled={ro || !controller.canUndo}>
        <Undo2 />
      </IconButton>
      <IconButton label={tt.redo} onClick={() => controller.redo()} disabled={ro || !controller.canRedo}>
        <Redo2 />
      </IconButton>
      <IconButton label={tt.print} onClick={() => controller.setPrinting(true)}>
        <Printer />
      </IconButton>
      <Menu
        label={tt.zoom}
        trigger={<span className="w-9 text-center text-xs">{Math.round(controller.zoom * 100)}%</span>}
        items={ZOOMS.map((z) => ({ key: String(z), label: `${Math.round(z * 100)}%`, checked: controller.zoom === z, onSelect: () => controller.setZoom(z) }))}
      />
      <Divider />
      <Menu
        label={tt.styles}
        disabled={ro}
        trigger={<span className="w-24 truncate text-left text-xs">{paragraphStyle ? (ts[paragraphStyle as keyof typeof ts] ?? controller.doc.styles.get(paragraphStyle)?.name) : ''}</span>}
        items={PARAGRAPH_STYLES.map((id) => ({
          key: id,
          label: <StylePreview controller={controller} id={id} label={ts[id]} />,
          checked: paragraphStyle === id,
          onSelect: () => controller.setParagraphStyle(id),
        }))}
      />
      <Divider />
      <Menu
        label={tt.font}
        disabled={ro}
        trigger={<span className="w-24 truncate text-left text-xs" style={{ fontFamily: style.font }}>{style.font}</span>}
        items={FONTS.map((font) => ({ key: font, label: <span style={{ fontFamily: font }}>{font}</span>, checked: style.font === font, onSelect: () => controller.setTextStyle({ font }) }))}
      />
      <Divider />
      <IconButton label={tt.decreaseSize} onClick={() => controller.setTextStyle({ size: stepSize(style.size, -1) })} disabled={ro}>
        <Minus />
      </IconButton>
      <SizeInput controller={controller} size={style.size} label={tt.fontSize} disabled={ro} />
      <IconButton label={tt.increaseSize} onClick={() => controller.setTextStyle({ size: stepSize(style.size, 1) })} disabled={ro}>
        <Plus />
      </IconButton>
      <Divider />
      <Toggle label={tt.bold} active={controller.isActive('bold')} onClick={() => controller.toggle('bold')} disabled={ro}>
        <Bold />
      </Toggle>
      <Toggle label={tt.italic} active={controller.isActive('italic')} onClick={() => controller.toggle('italic')} disabled={ro}>
        <Italic />
      </Toggle>
      <Toggle label={tt.underline} active={controller.isActive('underline')} onClick={() => controller.toggle('underline')} disabled={ro}>
        <Underline />
      </Toggle>
      <Toggle label={tt.strikethrough} active={controller.isActive('strike')} onClick={() => controller.toggle('strike')} disabled={ro}>
        <Strikethrough />
      </Toggle>
      <ColorButton label={tt.textColor} reset={tt.resetColor} value={style.color} onPick={(color) => controller.setTextStyle({ color })} disabled={ro}>
        <Baseline />
      </ColorButton>
      <ColorButton label={tt.highlightColor} reset={tt.none} value={style.highlight} onPick={(highlight) => controller.setTextStyle({ highlight })} disabled={ro}>
        <Highlighter />
      </ColorButton>
      <Divider />
      <IconButton label={tt.link} onClick={() => controller.openDialog('link')} disabled={ro}>
        <Link2 />
      </IconButton>
      <Divider />
      <Menu
        label={tt.align}
        disabled={ro}
        trigger={alignIcon(align)}
        items={[
          { key: 'left', label: tt.alignLeft, checked: align === 'left', onSelect: () => controller.setParagraph({ align: null }) },
          { key: 'center', label: tt.alignCenter, checked: align === 'center', onSelect: () => controller.setParagraph({ align: 'center' }) },
          { key: 'right', label: tt.alignRight, checked: align === 'right', onSelect: () => controller.setParagraph({ align: 'right' }) },
          { key: 'justify', label: tt.justify, checked: align === 'justify', onSelect: () => controller.setParagraph({ align: 'justify' }) },
        ]}
      />
      <Menu
        label={tt.lineSpacing}
        disabled={ro}
        trigger={<UnfoldVertical />}
        sections={[
          {
            items: LINE_HEIGHTS.map((h) => ({
              key: String(h),
              label: h === 1 ? tt.single : String(h),
              checked: Math.abs((para.lineHeight ?? 1) - h) < 0.01 && !para.lineHeightExact,
              onSelect: () => controller.setParagraph({ lineHeight: h, lineHeightExact: null }),
            })),
          },
          {
            items: [
              (para.spaceBefore ?? 0) > 0
                ? { key: 'rb', label: tt.spacingRemoveBefore, onSelect: () => controller.setParagraph({ spaceBefore: 0 }) }
                : { key: 'ab', label: tt.spacingAddBefore, onSelect: () => controller.setParagraph({ spaceBefore: 10 }) },
              (para.spaceAfter ?? 0) > 0
                ? { key: 'ra', label: tt.spacingRemoveAfter, onSelect: () => controller.setParagraph({ spaceAfter: 0 }) }
                : { key: 'aa', label: tt.spacingAddAfter, onSelect: () => controller.setParagraph({ spaceAfter: 10 }) },
            ],
          },
        ]}
      />
      <Toggle label={tt.checklist} active={listKind(controller) === 'check'} onClick={() => controller.toggleList('check')} disabled={ro}>
        <ListChecks />
      </Toggle>
      <Toggle label={tt.bulleted} active={listKind(controller) === 'bullet'} onClick={() => controller.toggleList('bullet')} disabled={ro}>
        <List />
      </Toggle>
      <Toggle label={tt.numbered} active={listKind(controller) === 'numbered'} onClick={() => controller.toggleList('numbered')} disabled={ro}>
        <ListOrdered />
      </Toggle>
      <IconButton label={tt.decreaseIndent} onClick={() => controller.indent(-1)} disabled={ro}>
        <IndentDecrease />
      </IconButton>
      <IconButton label={tt.increaseIndent} onClick={() => controller.indent(1)} disabled={ro}>
        <IndentIncrease />
      </IconButton>
      <IconButton label={tt.clearFormatting} onClick={() => controller.clearFormatting()} disabled={ro}>
        <RemoveFormatting />
      </IconButton>
    </div>
  );
}

function StylePreview({ controller, id, label }: { controller: DocController; id: string; label: string }) {
  const s = controller.doc.styles.get(id);
  const size = Math.min(20, Math.max(10, s?.text?.size ?? 11));
  return (
    <span style={{ fontSize: `${size}px`, fontWeight: s?.text?.bold ? 700 : undefined, fontStyle: s?.text?.italic ? 'italic' : undefined, color: s?.text?.color, fontFamily: s?.text?.font }}>
      {label}
    </span>
  );
}

function SizeInput({ controller, size, label, disabled }: { controller: DocController; size: number; label: string; disabled: boolean }) {
  const [draft, setDraft] = useState(String(size));
  useEffect(() => setDraft(String(Math.round(size * 10) / 10)), [size]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n >= 1 && n <= 400 && n !== size) controller.setTextStyle({ size: n });
    else setDraft(String(size));
  };
  return (
    <input
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      className="h-7 w-10 rounded border bg-background text-center text-xs outline-none focus:border-primary"
    />
  );
}

function stepSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return SIZES.find((s) => s > size) ?? Math.min(400, size + 12);
  return [...SIZES].reverse().find((s) => s < size) ?? Math.max(1, size - 1);
}

function listKind(controller: DocController): string | null {
  const list = controller.paragraph().list;
  if (!list) return null;
  const f = controller.doc.lists.get(list.id)?.levels[0]?.format;
  if (!f) return null;
  if (f === 'bullet' || f === 'check') return f;
  return 'numbered';
}

function alignIcon(align: string) {
  if (align === 'center') return <TextAlignCenter />;
  if (align === 'right') return <TextAlignEnd />;
  if (align === 'justify') return <TextAlignJustify />;
  return <TextAlignStart />;
}
