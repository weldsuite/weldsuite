import { useEffect, useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import { getBlockEditorStrings } from '../strings';

export interface TocEntry {
  id: string;
  level: number;
  text: string;
}

/** Plain text of a block's inline content (styled text and links). */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((node) => {
      if (!node || typeof node !== 'object') return '';
      const item = node as { text?: unknown; content?: unknown };
      if (typeof item.text === 'string') return item.text;
      return inlineText(item.content);
    })
    .join('');
}

/** Every heading in the document, in reading order, nested blocks included. */
export function collectHeadings(blocks: unknown): TocEntry[] {
  const entries: TocEntry[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const block = node as { id?: string; type?: string; props?: { level?: unknown }; content?: unknown; children?: unknown };
      if (block.type === 'heading' && block.id) {
        const level = typeof block.props?.level === 'number' ? block.props.level : 1;
        entries.push({ id: block.id, level, text: inlineText(block.content).trim() });
      }
      walk(block.children);
    }
  };
  walk(blocks);
  return entries;
}

/**
 * A live outline of the page's headings. Clicking an entry scrolls to it.
 * Nothing is stored in the block: the list is rebuilt from the document, so
 * it can never go stale.
 */
export const TableOfContentsBlock = createReactBlockSpec(
  {
    type: 'tableOfContents',
    propSchema: {},
    content: 'none',
  },
  {
    render: ({ editor }) => <TableOfContents editor={editor} />,
  },
);

interface TocEditor {
  document: unknown;
  domElement?: HTMLElement | null;
  onChange: (callback: () => void) => (() => void) | undefined;
}

function TableOfContents({ editor }: Readonly<{ editor: TocEditor }>) {
  const t = getBlockEditorStrings();
  const [entries, setEntries] = useState<TocEntry[]>(() => collectHeadings(editor.document));

  useEffect(() => {
    const refresh = () => {
      const next = collectHeadings(editor.document);
      setEntries((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    refresh();
    return editor.onChange(refresh);
  }, [editor]);

  if (entries.length === 0) {
    return (
      <p contentEditable={false} className="w-full text-sm text-muted-foreground">
        {t.tableOfContents.empty}
      </p>
    );
  }

  const minLevel = Math.min(...entries.map((entry) => entry.level));

  return (
    <nav contentEditable={false} className="flex w-full flex-col">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => {
            const target = editor.domElement?.querySelector(`[data-node-type="blockContainer"][data-id="${entry.id}"]`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          style={{ paddingLeft: (entry.level - minLevel) * 16 }}
          className="cursor-pointer truncate py-0.5 text-left text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {entry.text || t.tableOfContents.untitled}
        </button>
      ))}
    </nav>
  );
}
