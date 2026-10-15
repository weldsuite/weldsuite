/**
 * The toolbar that floats above a text selection (Attio's layout): Ask Agent,
 * block type ("Body"), text color, highlight, link, then bold / italic /
 * strikethrough. Editors with this toolbar opt out of the global "Ask Agent"
 * selection bubble (components/text-selection-tooltip.tsx), so it lives here.
 * Rendered through BlockNote's FormattingToolbarController, which positions it
 * and shows it only while text is selected.
 */

import { useState, type ReactNode } from 'react';
import { useBlockNoteEditor, useEditorState } from '@blocknote/react';
import { Bold, Italic, Link2, Strikethrough } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Input } from '@weldsuite/ui/components/input';
import { cn } from '@/lib/utils';
import { useMobileNav } from '@/contexts/mobile-nav-context';
import { getBlockEditorStrings, type BlockEditorStrings } from './strings';

type Strings = BlockEditorStrings['selectionToolbar'];

type BlockKind =
  | 'paragraph' | 'heading1' | 'heading2' | 'heading3'
  | 'bulletListItem' | 'numberedListItem' | 'checkListItem' | 'quote';

const BLOCK_KINDS: { kind: BlockKind; label: keyof Strings }[] = [
  { kind: 'paragraph', label: 'body' },
  { kind: 'heading1', label: 'heading1' },
  { kind: 'heading2', label: 'heading2' },
  { kind: 'heading3', label: 'heading3' },
  { kind: 'bulletListItem', label: 'bulletList' },
  { kind: 'numberedListItem', label: 'numberedList' },
  { kind: 'checkListItem', label: 'checklist' },
  { kind: 'quote', label: 'quote' },
];

const COLORS = ['default', 'gray', 'brown', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
type Color = (typeof COLORS)[number];

/** Swatch per text color; `default` follows the theme's text color. */
const TEXT_SWATCHES: Record<Exclude<Color, 'default'>, string> = {
  gray: '#6b7280', brown: '#92400e', red: '#dc2626', orange: '#ea580c', yellow: '#ca8a04',
  green: '#16a34a', blue: '#2563eb', purple: '#9333ea', pink: '#db2777',
};

/** Swatch per highlight; `default` means no highlight. */
const HIGHLIGHT_SWATCHES: Record<Exclude<Color, 'default'>, string> = {
  gray: '#e5e7eb', brown: '#fde4c9', red: '#fecaca', orange: '#fed7aa', yellow: '#fde68a',
  green: '#bbf7d0', blue: '#bfdbfe', purple: '#e9d5ff', pink: '#fbcfe8',
};

function kindOfBlock(block: { type: string; props?: Record<string, unknown> } | undefined): BlockKind {
  if (!block) return 'paragraph';
  if (block.type === 'heading') {
    const level = Number(block.props?.level ?? 1);
    if (level === 2) return 'heading2';
    if (level === 3) return 'heading3';
    return 'heading1';
  }
  const kind = BLOCK_KINDS.find((k) => k.kind === block.type)?.kind;
  return kind ?? 'paragraph';
}

/** A round swatch; the "none" swatch is struck through like Attio's. */
function Swatch({ color, none = false }: Readonly<{ color?: string; none?: boolean }>) {
  if (none) {
    return (
      <span className="relative inline-block size-3.5 flex-shrink-0 overflow-hidden rounded-full border border-border bg-background">
        <span className="absolute left-1/2 top-[-2px] h-[18px] w-[1.5px] -translate-x-1/2 rotate-45 bg-red-500" />
      </span>
    );
  }
  return (
    <span
      className={cn('inline-block size-3.5 flex-shrink-0 rounded-full border border-border', !color && 'bg-foreground')}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

function Divider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

/** Keep the editor selection while a toolbar control is pressed. */
const keepSelection = (e: React.MouseEvent) => e.preventDefault();

function ToolbarButton({
  label,
  active = false,
  onClick,
  children,
  className,
}: Readonly<{ label: string; active?: boolean; onClick?: () => void; children: ReactNode; className?: string }>) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={keepSelection}
      onClick={onClick}
      className={cn(
        'h-7 gap-1.5 rounded-md px-2 has-[>svg]:px-2 text-sm font-normal text-muted-foreground hover:text-foreground',
        active && 'bg-accent text-foreground',
        className,
      )}
    >
      {children}
    </Button>
  );
}

export function SelectionToolbar() {
  const editor = useBlockNoteEditor();
  const s = getBlockEditorStrings().selectionToolbar;
  const { setShowWeldAgent, setWeldAgentPrefill } = useMobileNav();
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');

  const state = useEditorState({
    editor,
    selector: ({ editor: ed }) => {
      const styles = ed.getActiveStyles() as Record<string, unknown>;
      const block = ed.getTextCursorPosition().block as { type: string; props?: Record<string, unknown> };
      return {
        bold: !!styles.bold,
        italic: !!styles.italic,
        strike: !!styles.strike,
        textColor: (styles.textColor as string | undefined) || 'default',
        backgroundColor: (styles.backgroundColor as string | undefined) || 'default',
        blockKind: kindOfBlock(block),
        linkUrl: (ed as unknown as { getSelectedLinkUrl?: () => string | undefined }).getSelectedLinkUrl?.() ?? '',
      };
    },
  });
  if (!state) return null;

  const selectedBlocks = () => {
    const blocks = editor.getSelection()?.blocks;
    return blocks && blocks.length > 0 ? blocks : [editor.getTextCursorPosition().block];
  };

  const setBlockKind = (kind: BlockKind) => {
    for (const block of selectedBlocks()) {
      if (kind.startsWith('heading')) {
        editor.updateBlock(block, { type: 'heading', props: { level: Number(kind.slice(-1)) } } as never);
      } else {
        editor.updateBlock(block, { type: kind } as never);
      }
    }
    editor.focus();
  };

  const setColor = (kind: 'textColor' | 'backgroundColor', color: Color) => {
    editor.addStyles({ [kind]: color } as never);
    editor.focus();
  };

  const toggle = (style: 'bold' | 'italic' | 'strike') => {
    editor.toggleStyles({ [style]: true } as never);
  };

  // Same as the global selection bubble: open WeldAgent with the selected text.
  const askAgent = () => {
    const text = editor.getSelectedText().trim();
    if (!text) return;
    setWeldAgentPrefill(text);
    setShowWeldAgent(true);
  };

  const applyLink = () => {
    const url = linkUrl.trim();
    if (url) {
      const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
      (editor as unknown as { createLink: (url: string) => void }).createLink(href);
    }
    setLinkOpen(false);
    editor.focus();
  };

  const currentKindLabel = s[BLOCK_KINDS.find((k) => k.kind === state.blockKind)?.label ?? 'body'] as string;
  const textSwatch = state.textColor === 'default' ? undefined : TEXT_SWATCHES[state.textColor as Exclude<Color, 'default'>];
  const highlightSwatch = state.backgroundColor === 'default'
    ? undefined
    : HIGHLIGHT_SWATCHES[state.backgroundColor as Exclude<Color, 'default'>];

  return (
    <div
      className="flex h-9 items-center gap-0.5 rounded-lg border border-border bg-popover px-1 text-popover-foreground shadow-md"
      onMouseDown={keepSelection}
    >
      {/* Ask Agent */}
      <ToolbarButton label={s.askAgent} onClick={askAgent} className="text-foreground">
        <img src="/assets/images/weldagent/logo-light.png" alt="" className="h-4 w-4" />
        {s.askAgent}
      </ToolbarButton>

      <Divider />

      {/* Block type */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            onMouseDown={keepSelection}
            className="h-7 rounded-md px-2 has-[>svg]:px-2 text-sm font-normal text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            {currentKindLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40" onCloseAutoFocus={(e) => e.preventDefault()}>
          {BLOCK_KINDS.map((k) => (
            <DropdownMenuCheckboxItem
              checkPosition="right"
              key={k.kind}
              checked={state.blockKind === k.kind}
              onSelect={() => setBlockKind(k.kind)}
            >
              {s[k.label] as string}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Divider />

      {/* Text color */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            onMouseDown={keepSelection}
            className="h-7 gap-1.5 rounded-md px-2 has-[>svg]:px-2 text-sm font-normal text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            {s.text}
            <Swatch color={textSwatch} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40" onCloseAutoFocus={(e) => e.preventDefault()}>
          {COLORS.map((color) => (
            <DropdownMenuCheckboxItem
              checkPosition="right"
              key={color}
              checked={state.textColor === color}
              onSelect={() => setColor('textColor', color)}
            >
              <Swatch color={color === 'default' ? undefined : TEXT_SWATCHES[color]} />
              {s.colors[color]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Highlight */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            onMouseDown={keepSelection}
            className="h-7 gap-1.5 rounded-md px-2 has-[>svg]:px-2 text-sm font-normal text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            {s.highlight}
            <Swatch color={highlightSwatch} none={!highlightSwatch} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40" onCloseAutoFocus={(e) => e.preventDefault()}>
          {COLORS.map((color) => (
            <DropdownMenuCheckboxItem
              checkPosition="right"
              key={color}
              checked={state.backgroundColor === color}
              onSelect={() => setColor('backgroundColor', color)}
            >
              {color === 'default' ? <Swatch none /> : <Swatch color={HIGHLIGHT_SWATCHES[color]} />}
              {color === 'default' ? s.noHighlight : s.colors[color]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Divider />

      {/* Link */}
      <Popover
        open={linkOpen}
        onOpenChange={(open) => {
          setLinkOpen(open);
          if (open) setLinkUrl(state.linkUrl);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={s.link}
            title={s.link}
            onMouseDown={keepSelection}
            className={cn(
              'size-7 rounded-md text-muted-foreground hover:text-foreground',
              (linkOpen || !!state.linkUrl) && 'bg-accent text-foreground',
            )}
          >
            <Link2 className="size-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2" onCloseAutoFocus={(e) => e.preventDefault()}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              applyLink();
            }}
          >
            <Input
              autoFocus
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder={s.linkPlaceholder}
              className="h-8 text-sm"
            />
          </form>
        </PopoverContent>
      </Popover>

      <Divider />

      {/* Inline styles */}
      <ToolbarButton label={s.bold} active={state.bold} onClick={() => toggle('bold')} className="size-7 px-0 has-[>svg]:px-0">
        <Bold className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label={s.italic} active={state.italic} onClick={() => toggle('italic')} className="size-7 px-0 has-[>svg]:px-0">
        <Italic className="size-3.5" />
      </ToolbarButton>
      <ToolbarButton label={s.strike} active={state.strike} onClick={() => toggle('strike')} className="size-7 px-0 has-[>svg]:px-0">
        <Strikethrough className="size-3.5" />
      </ToolbarButton>
    </div>
  );
}
