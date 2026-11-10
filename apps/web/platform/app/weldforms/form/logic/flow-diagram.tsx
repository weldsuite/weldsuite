/**
 * A read-only diagram of the flow: blocks as nodes in order, endings in a
 * second column, jumps as curved edges. Clicking a node selects it, which the
 * rules editor beside it follows. Plain SVG; the form's size (a few dozen
 * blocks) doesn't call for the WeldConnect canvas.
 */

import type { FormDefinition } from '@weldsuite/forms-engine';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';

const NODE_W = 230;
const NODE_H = 34;
const GAP = 16;
const TOP = 24;
const LEFT = 16;
const END_X = LEFT + NODE_W + 150;
const ARROW = 5;

export type EdgeKind = 'jump' | 'otherwise' | 'ending-rule' | 'default';

export interface FlowNode {
  id: string;
  kind: 'block' | 'ending';
  label: string;
  x: number;
  y: number;
  /** Question number for blocks that are questions. */
  number: number | null;
  hasLogic: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

/** Positions the nodes and lists the edges. Pure, so it is easy to test. */
export function layoutFlow(def: FormDefinition, labels: { untitled: string }): FlowLayout {
  let n = 0;
  const blocks = def.blocks.filter((b) => b.type !== 'page_break');
  const nodes: FlowNode[] = blocks.map((block, i) => {
    const isQuestion = block.type !== 'statement' && block.type !== 'group';
    if (isQuestion) n += 1;
    return {
      id: block.id,
      kind: 'block',
      label: block.title.trim() || labels.untitled,
      x: LEFT,
      y: TOP + i * (NODE_H + GAP),
      number: isQuestion ? n : null,
      hasLogic: def.logic.some((l) => l.blockId === block.id && (l.jumps.length > 0 || l.otherwise !== null || l.calculations.length > 0)),
    };
  });
  const endingNodes: FlowNode[] = def.endings.map((ending, i) => ({
    id: ending.id,
    kind: 'ending',
    label: ending.title.trim() || labels.untitled,
    x: END_X,
    y: TOP + i * (NODE_H + GAP),
    number: null,
    hasLogic: false,
  }));

  const edges: FlowEdge[] = [];
  for (const block of blocks) {
    const logic = def.logic.find((l) => l.blockId === block.id);
    for (const jump of logic?.jumps ?? []) edges.push({ from: block.id, to: jump.to.id, kind: 'jump' });
    if (logic?.otherwise) edges.push({ from: block.id, to: logic.otherwise.id, kind: 'otherwise' });
  }
  const last = blocks[blocks.length - 1];
  if (last) {
    for (const rule of def.endingRules) edges.push({ from: last.id, to: rule.endingId, kind: 'ending-rule' });
    const first = def.endings[0];
    if (first) edges.push({ from: last.id, to: first.id, kind: 'default' });
  }

  const rows = Math.max(nodes.length, endingNodes.length, 1);
  return { nodes: [...nodes, ...endingNodes], edges, width: END_X + NODE_W + LEFT + 40, height: TOP * 2 + rows * (NODE_H + GAP) };
}

function edgePath(from: FlowNode, to: FlowNode, lane: number): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  if (to.kind === 'ending') {
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const mid = (x1 + x2) / 2 + lane * 4;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - ARROW} ${y2}`;
  }
  const x2 = to.x + NODE_W;
  const y2 = to.y + NODE_H / 2;
  const out = 28 + lane * 12;
  return `M ${x1} ${y1} C ${x1 + out} ${y1}, ${x2 + out} ${y2}, ${x2 + ARROW} ${y2}`;
}

interface Props {
  definition: FormDefinition;
  selectedId: string | null;
  onSelect: (id: string, kind: 'block' | 'ending') => void;
}

export function FlowDiagram({ definition, selectedId, onSelect }: Readonly<Props>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const layout = layoutFlow(definition, { untitled: t.weldforms.outline.untitled });
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));

  // Edges between the same pair share the space: each gets its own lane.
  const lanes = new Map<string, number>();
  const edges = layout.edges.flatMap((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return [];
    const key = `${edge.from}>${edge.to}`;
    const lane = lanes.get(key) ?? 0;
    lanes.set(key, lane + 1);
    return [{ edge, index, path: edgePath(from, to, lane + (to.kind === 'block' ? Math.max(0, Math.round((to.y - from.y) / (NODE_H + GAP)) % 4) : 0)) }];
  });

  return (
    <div className="overflow-auto rounded-md border bg-card">
      <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={tl.flowLabel} className="block min-w-full">
        <defs>
          <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" />
          </marker>
          <marker id="wf-arrow-primary" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="fill-primary" />
          </marker>
        </defs>

        {/* The natural order: a short connector from each block to the next. */}
        {layout.nodes
          .filter((n) => n.kind === 'block')
          .map((node, i, blocks) => {
            const next = blocks[i + 1];
            if (!next) return null;
            return <line key={`seq-${node.id}`} x1={node.x + NODE_W / 2} y1={node.y + NODE_H} x2={next.x + NODE_W / 2} y2={next.y - 1} className="stroke-border" strokeWidth={1.5} />;
          })}

        {edges.map(({ edge, index, path }) => (
          <path
            key={`${edge.kind}-${index}`}
            d={path}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray={edge.kind === 'otherwise' || edge.kind === 'default' ? '4 3' : undefined}
            markerEnd={edge.kind === 'jump' || edge.kind === 'ending-rule' ? 'url(#wf-arrow-primary)' : 'url(#wf-arrow)'}
            className={edge.kind === 'jump' || edge.kind === 'ending-rule' ? 'stroke-primary' : 'stroke-muted-foreground/60'}
          />
        ))}

        {layout.nodes.map((node) => {
          const selected = node.id === selectedId;
          return (
            <g
              key={node.id}
              transform={`translate(${node.x} ${node.y})`}
              role="button"
              tabIndex={0}
              aria-label={node.label}
              aria-pressed={selected}
              onClick={() => onSelect(node.id, node.kind)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(node.id, node.kind);
                }
              }}
              className="cursor-pointer outline-none"
            >
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                className={cn('fill-background stroke-border', node.kind === 'ending' && 'fill-muted', selected && 'stroke-primary', node.hasLogic && !selected && 'stroke-primary/50')}
                strokeWidth={selected ? 2 : 1}
              />
              <text x={12} y={NODE_H / 2 + 4} className="fill-foreground text-[12px]">
                {node.number !== null ? `${node.number}. ` : ''}
                {truncate(node.label, 30)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
