import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { elementText, readingOrderIds, type Board, type BoardElement } from '@weldsuite/board-engine';
import { useI18n } from '@/lib/i18n/provider';
import type { BoardController } from '../model/board-controller';
import { revealElement } from '../model/focus';

/** Most elements the screen-reader outline lists (a board can hold tens of thousands). */
const OUTLINE_LIMIT = 400;
/** How long the outline waits after a change before it is rebuilt (drags change the board every frame). */
const OUTLINE_DELAY = 800;

interface OutlineNode {
  id: string;
  type: BoardElement['type'];
  text: string;
  children: OutlineNode[];
}

interface Outline {
  nodes: OutlineNode[];
  /** Every element id in reading order. */
  order: string[];
}

const textOf = (el: BoardElement) => elementText(el).replace(/\s+/g, ' ').slice(0, 200);

/** Frames with what they hold, in reading order, up to `limit` elements. */
function outlineOf(board: Board, limit: number): Outline {
  const order = readingOrderIds(board);
  const nodes: OutlineNode[] = [];
  const byId = new Map<string, OutlineNode>();
  for (const id of order.slice(0, limit)) {
    const el = board.get(id);
    if (!el) continue;
    const node: OutlineNode = { id, type: el.type, text: textOf(el), children: [] };
    byId.set(id, node);
    // A frame's contents come right after it, so its node already exists.
    let parent = board.effectiveParent(el);
    while (parent && !byId.has(parent)) {
      const up = board.get(parent);
      parent = up ? board.effectiveParent(up) : null;
    }
    (parent ? byId.get(parent)!.children : nodes).push(node);
  }
  return { nodes, order };
}

type Label = (node: { type: BoardElement['type']; text: string }) => string;

const OutlineList = memo(function OutlineList({ nodes, label, onPick }: { nodes: OutlineNode[]; label: Label; onPick: (id: string) => void }) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.id}>
          <button type="button" tabIndex={-1} onClick={() => onPick(node.id)}>
            {label(node)}
          </button>
          {node.children.length > 0 && <OutlineList nodes={node.children} label={label} onPick={onPick} />}
        </li>
      ))}
    </ul>
  );
});

/**
 * What a screen reader gets of the board, which is otherwise a canvas: a
 * live region saying what is selected (its kind, its text and where it is in
 * reading order), and an outline of frames and their contents as buttons
 * that select an element. Both are visually hidden, and both are rebuilt only
 * once the board has been still for a moment.
 */
export function BoardA11y({ controller: c, onFocusBoard }: { controller: BoardController; onFocusBoard: () => void }) {
  const { t, format } = useI18n();
  const ta = t.weldboard.editor.a11y;
  const version = useSyncExternalStore(c.subscribe, c.getVersion);
  const [outline, setOutline] = useState<Outline>(() => outlineOf(c.board, OUTLINE_LIMIT));
  const [announcement, setAnnouncement] = useState('');

  const label = useCallback<Label>((node) => `${(ta.types as Record<string, string>)[node.type] ?? node.type}: ${node.text || ta.noText}`, [ta]);

  useEffect(() => {
    const id = window.setTimeout(() => setOutline(outlineOf(c.board, OUTLINE_LIMIT)), OUTLINE_DELAY);
    return () => window.clearTimeout(id);
  }, [c, version]);

  // What is selected, said when the selection changes.
  const selectionKey = [...c.selection].join(',');
  useEffect(() => {
    if (c.selection.size > 1) {
      setAnnouncement(format(ta.selected, { count: c.selection.size }));
      return;
    }
    const el = c.selection.size === 1 ? c.board.get([...c.selection][0]!) : undefined;
    if (!el) {
      setAnnouncement('');
      return;
    }
    const index = outline.order.indexOf(el.id);
    const where = index >= 0 ? `, ${format(ta.position, { index: index + 1, count: outline.order.length })}` : '';
    setAnnouncement(`${label({ type: el.type, text: textOf(el) })}${where}`);
    // The outline's order is a moment old at most; good enough to say where an element is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  const pick = useCallback(
    (id: string) => {
      const el = c.board.get(id);
      if (!el) return;
      c.select([id]);
      revealElement(c, el);
      onFocusBoard();
    },
    [c, onFocusBoard],
  );

  const total = outline.order.length;
  return (
    <div className="sr-only">
      <p aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <nav aria-label={ta.outline}>
        <p>{total ? ta.howTo : ta.empty}</p>
        <OutlineList nodes={outline.nodes} label={label} onPick={pick} />
        {total > OUTLINE_LIMIT && <p>{format(ta.more, { count: total - OUTLINE_LIMIT })}</p>}
      </nav>
    </div>
  );
}
