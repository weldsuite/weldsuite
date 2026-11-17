/**
 * The form's flow on the WeldConnect canvas: React Flow with the same dotted
 * background, zoom controls and step cards (`@weldsuite/ui`'s workflow
 * canvas). A start card on top, the blocks top to bottom, the endings in a row
 * under them. Jumps and "otherwise" routes leave a card on its right side;
 * jumps are blue, otherwise routes dashed. Clicking a card selects it, and the
 * Logic tab opens its rules beside the canvas.
 *
 * The canvas's own `WorkflowCanvas` draws trigger-and-steps trees and can't
 * show a jump back or forward, so this mounts the same pieces in its own
 * React Flow.
 */

import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { LucideIcon } from 'lucide-react';
import { Play } from 'lucide-react';
import type { FormDefinition } from '@weldsuite/forms-engine';
import { CanvasControls, NODE_HEIGHT, NODE_WIDTH, STEP_HANDLE_CLASS, StepCard } from '@weldsuite/ui/components/workflow-canvas';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { BLOCK_ICONS, ENDING_ICON, type BlockKind } from '../../lib/block-types';

/** Space between two cards in the column. */
const GAP_Y = 64;
const ROW = NODE_HEIGHT + GAP_Y;
/** Space between two endings in their row. */
const GAP_X = 48;
export const START_ID = '__start__';

export type EdgeKind = 'sequence' | 'jump' | 'otherwise' | 'ending-rule' | 'default';

export interface FlowNode {
  id: string;
  kind: 'start' | 'block' | 'ending';
  label: string;
  type: BlockKind | null;
  x: number;
  y: number;
  /** Question number for blocks that are questions. */
  number: number | null;
  /** Calculations, jumps and an otherwise route on the block. */
  rules: number;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

/** Positions the cards and lists the connectors. Pure, so it is easy to test. */
export function layoutFlow(def: FormDefinition, labels: { untitled: string }): { nodes: FlowNode[]; edges: FlowEdge[] } {
  let n = 0;
  const blocks = def.blocks.filter((b) => b.type !== 'page_break');
  const start: FlowNode = { id: START_ID, kind: 'start', label: '', type: null, x: -NODE_WIDTH / 2, y: 0, number: null, rules: 0 };
  const blockNodes: FlowNode[] = blocks.map((block, i) => {
    const isQuestion = block.type !== 'statement' && block.type !== 'group';
    if (isQuestion) n += 1;
    const logic = def.logic.find((l) => l.blockId === block.id);
    return {
      id: block.id,
      kind: 'block',
      label: block.title.trim() || labels.untitled,
      type: block.type as BlockKind,
      x: -NODE_WIDTH / 2,
      y: (i + 1) * ROW,
      number: isQuestion ? n : null,
      rules: (logic?.jumps.length ?? 0) + (logic?.calculations.length ?? 0) + (logic?.otherwise ? 1 : 0),
    };
  });
  const endingsY = (blocks.length + 1) * ROW;
  const middle = (def.endings.length - 1) / 2;
  const endingNodes: FlowNode[] = def.endings.map((ending, j) => ({
    id: ending.id,
    kind: 'ending',
    label: ending.title.trim() || labels.untitled,
    type: null,
    x: (j - middle) * (NODE_WIDTH + GAP_X) - NODE_WIDTH / 2,
    y: endingsY,
    number: null,
    rules: 0,
  }));

  const edges: FlowEdge[] = [];
  const column = [start, ...blockNodes];
  for (let i = 1; i < column.length; i++) edges.push({ from: column[i - 1]!.id, to: column[i]!.id, kind: 'sequence' });
  for (const block of blocks) {
    const logic = def.logic.find((l) => l.blockId === block.id);
    for (const jump of logic?.jumps ?? []) edges.push({ from: block.id, to: jump.to.id, kind: 'jump' });
    if (logic?.otherwise) edges.push({ from: block.id, to: logic.otherwise.id, kind: 'otherwise' });
  }
  // Past the last card: the endings a rule picks, and the first ending for everyone else. One connector per ending.
  const last = column.at(-1)!;
  const ruled = new Set(def.endingRules.map((rule) => rule.endingId));
  const fallback = def.endings[0];
  if (fallback) edges.push({ from: last.id, to: fallback.id, kind: ruled.has(fallback.id) ? 'ending-rule' : 'default' });
  for (const ending of def.endings) {
    if (ending.id !== fallback?.id && ruled.has(ending.id)) edges.push({ from: last.id, to: ending.id, kind: 'ending-rule' });
  }

  return { nodes: [start, ...blockNodes, ...endingNodes], edges };
}

interface CardData extends Record<string, unknown> {
  kind: FlowNode['kind'];
  icon: LucideIcon;
  title: string;
  typeLabel: string;
  summary?: string;
  selected: boolean;
  onSelect?: () => void;
}

/** A handle the connectors attach to without showing it. */
const HIDDEN_HANDLE = '!border-0 !bg-transparent';
const HIDDEN_HANDLE_STYLE = { width: 0, height: 0, minWidth: 0, minHeight: 0 };

function FormCardNode({ data }: NodeProps<Node<CardData>>) {
  return (
    <div className="relative">
      {data.kind !== 'start' && <Handle id="in" type="target" position={Position.Top} isConnectable={false} className={HIDDEN_HANDLE} style={{ ...HIDDEN_HANDLE_STYLE, top: 0 }} />}
      {data.kind === 'block' && <Handle id="side-in" type="target" position={Position.Right} isConnectable={false} className={HIDDEN_HANDLE} style={HIDDEN_HANDLE_STYLE} />}
      <StepCard
        as={data.onSelect ? 'button' : 'div'}
        icon={data.icon}
        title={data.title}
        typeLabel={data.typeLabel}
        summary={data.summary}
        state={data.selected ? 'selected' : 'default'}
        onClick={data.onSelect}
      />
      {data.kind !== 'ending' && <Handle id="out" type="source" position={Position.Bottom} isConnectable={false} className={cn(STEP_HANDLE_CLASS, '!z-10 !invisible lg:!visible')} style={{ bottom: '1px' }} />}
      {data.kind === 'block' && <Handle id="side-out" type="source" position={Position.Right} isConnectable={false} className={HIDDEN_HANDLE} style={HIDDEN_HANDLE_STYLE} />}
    </div>
  );
}

const nodeTypes = { formCard: FormCardNode };

const PRIMARY = 'var(--color-primary)';
const MUTED = 'var(--color-muted-foreground)';

interface Props {
  definition: FormDefinition;
  selectedId: string | null;
  onSelect: (id: string, kind: 'block' | 'ending') => void;
  /** Shown over the canvas, top centre (the read-only notice). */
  notice?: React.ReactNode;
}

export function FlowDiagram(props: Readonly<Props>) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvas({ definition, selectedId, onSelect, notice }: Readonly<Props>) {
  const { t } = useI18n();
  const tl = t.weldforms.logic;
  const tp = t.weldforms.properties;
  const blockTypes = t.weldforms.blockTypes as Record<string, string>;
  const untitled = t.weldforms.outline.untitled;

  const { nodes, edges } = useMemo(() => {
    const layout = layoutFlow(definition, { untitled });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    const nodes: Node<CardData>[] = layout.nodes.map((node) => {
      let data: CardData;
      if (node.kind === 'start') {
        data = { kind: 'start', icon: Play, title: tl.startTitle, typeLabel: tl.start, summary: definition.welcome?.title.trim() || undefined, selected: false };
      } else if (node.kind === 'ending') {
        data = { kind: 'ending', icon: ENDING_ICON, title: node.label, typeLabel: tp.ending, selected: false, onSelect: () => onSelect(node.id, 'ending') };
      } else {
        data = {
          kind: 'block',
          icon: BLOCK_ICONS[node.type ?? 'statement'],
          title: node.number === null ? node.label : `${node.number}. ${node.label}`,
          typeLabel: blockTypes[node.type ?? ''] ?? '',
          summary: node.rules === 0 ? tp.noLogic : tp.logicCount.replace('{count}', String(node.rules)),
          selected: node.id === selectedId,
          onSelect: () => onSelect(node.id, 'block'),
        };
      }
      // Selectable keeps the card clickable (React Flow drops pointer events on a node that is neither selectable nor draggable); the highlight comes from `data.selected`.
      return { id: node.id, type: 'formCard', position: { x: node.x, y: node.y }, data, draggable: false, selectable: node.kind !== 'start' };
    });

    // Routes that leave a card on its side fan out, so two of them don't run on top of each other.
    let lane = 0;
    const edges: Edge[] = layout.edges.flatMap((edge, index) => {
      const target = byId.get(edge.to);
      if (!byId.has(edge.from) || !target) return [];
      const side = edge.kind === 'jump' || edge.kind === 'otherwise';
      const highlighted = edge.kind === 'jump' || edge.kind === 'ending-rule';
      const dashed = edge.kind === 'otherwise' || edge.kind === 'default';
      const color = highlighted ? PRIMARY : MUTED;
      const offset = side ? 28 + (lane++ % 5) * 16 : 20;
      return [
        {
          id: `${edge.kind}-${index}`,
          source: edge.from,
          target: edge.to,
          sourceHandle: side ? 'side-out' : 'out',
          targetHandle: side && target.kind === 'block' ? 'side-in' : 'in',
          type: 'smoothstep',
          pathOptions: { offset, borderRadius: 8 },
          selectable: false,
          style: edge.kind === 'sequence' ? { strokeWidth: 1.5 } : { strokeWidth: 1.5, stroke: color, strokeDasharray: dashed ? '5 4' : undefined },
          markerEnd: edge.kind === 'sequence' ? undefined : { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        },
      ];
    });
    return { nodes, edges };
  }, [definition, selectedId, onSelect, untitled, tl.startTitle, tl.start, tp.ending, tp.noLogic, tp.logicCount, blockTypes]);

  return (
    <ReactFlow
      className="!bg-muted/30"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.25}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      zoomOnScroll={false}
      panOnScroll
      aria-label={tl.flowLabel}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="currentColor" className="!text-muted-foreground/30" />
      {notice ? (
        <Panel position="top-center" className="!mt-4">
          {notice}
        </Panel>
      ) : null}
      <CanvasControls labels={{ zoomIn: tl.zoomIn, zoomOut: tl.zoomOut, resetLayout: tl.fitView }} />
    </ReactFlow>
  );
}
