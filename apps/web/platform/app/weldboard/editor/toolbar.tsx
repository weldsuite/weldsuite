import type { ReactNode } from 'react';
import {
  Cloud,
  Eraser,
  Frame,
  Hand,
  Highlighter,
  ImagePlus,
  Paperclip,
  LayoutTemplate,
  MessageSquarePlus,
  MousePointer2,
  Network,
  Pencil,
  Redo2,
  Shapes,
  Spline,
  SquareKanban,
  StickyNote,
  Type,
  Undo2,
  Database,
} from 'lucide-react';
import { pathToSvg, shapeOutline, STICKY_COLORS, PALETTE, type ConnectorRoute, type ShapeKind } from '@weldsuite/board-engine';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import { DROPPABLE_TOOLS, isDrawingTool, type DrawingTool, type ToolKind } from './model/tools';
import { Swatches } from './swatches';
import { BarButton, BarPopover, Divider, TOOL_BUTTON, type Shortcut } from './ui';

export const BASIC_SHAPES: ShapeKind[] = ['rectangle', 'rounded', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'cross', 'parallelogram', 'trapezoid', 'cloud', 'callout', 'arrow-right', 'arrow-left', 'chevron', 'cylinder'];
/** Flowchart symbols, named for what they mean there (a rectangle is a process step). */
export const FLOW_SHAPES: [ShapeKind, 'terminator' | 'process' | 'decision' | 'data' | 'document' | 'predefined' | 'delay' | 'manual-input' | 'database'][] = [
  ['terminator', 'terminator'],
  ['rectangle', 'process'],
  ['diamond', 'decision'],
  ['data', 'data'],
  ['document', 'document'],
  ['predefined', 'predefined'],
  ['delay', 'delay'],
  ['manual-input', 'manual-input'],
  ['cylinder', 'database'],
];

/** Pen widths, and the dot each is shown as (steps far enough apart to tell them apart). */
const PEN_WIDTHS: [number, number][] = [
  [2, 5],
  [3, 8],
  [5, 11],
  [8, 15],
  [12, 20],
];

/** The drawing button shows the drawing tool it picks. */
function drawingIcon(tool: DrawingTool): ReactNode {
  if (tool === 'highlighter') return <Highlighter />;
  if (tool === 'eraser') return <Eraser />;
  return <Pencil />;
}

export function ShapeIcon({ kind, className }: { kind: ShapeKind; className?: string }) {
  // The cloud's bumps are lost at icon size: a cloud glyph says it. The circle is drawn round.
  if (kind === 'cloud') return <Cloud className={cn('size-5', className)} strokeWidth={1.6} aria-hidden />;
  const round = kind === 'ellipse';
  return (
    <svg viewBox="-2 -2 28 24" className={cn('size-5', className)} aria-hidden>
      <path
        d={pathToSvg(shapeOutline(kind, round ? 20 : 24, 20, kind === 'rounded' ? 5 : 0))}
        transform={round ? 'translate(2 0)' : undefined}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ToolbarProps {
  controller: BoardController;
  onImage: () => void;
  /** Adds a file card (where files can be stored). */
  onFile?: () => void;
  onTemplates: () => void;
  onRecords?: () => void;
}

/** Each tool's single-key shortcut (`TOOL_KEYS`). */
const TOOL_SHORTCUTS: Partial<Record<ToolKind, Shortcut>> = {
  select: ['V'],
  hand: ['H'],
  sticky: ['N'],
  shape: ['S'],
  text: ['T'],
  connector: ['L'],
  pen: ['P'],
  eraser: ['E'],
  frame: ['F'],
  comment: ['C'],
  mindmap: ['M'],
};

export function Toolbar({ controller: c, onImage, onFile, onTemplates, onRecords }: ToolbarProps) {
  const { t } = useI18n();
  const tt = t.weldboard.editor.tools;
  const ts = t.weldboard.editor.shapes;
  const tool = c.tool;
  const drawing = c.toolOptions.drawingTool;
  const ro = c.readOnly;

  const pick = (next: ToolKind) => () => c.setTool(next);
  const lock = (next: ToolKind) => () => c.setTool(next, true);
  const button = (kind: ToolKind, label: string, icon: ReactNode, disabled = false) => (
    <BarButton
      key={kind}
      label={label}
      keys={TOOL_SHORTCUTS[kind]}
      side="bottom"
      className={TOOL_BUTTON}
      active={tool === kind}
      disabled={disabled}
      onClick={pick(kind)}
      onDoubleClick={lock(kind)}
      dragTool={DROPPABLE_TOOLS.has(kind) ? kind : undefined}
    >
      {icon}
    </BarButton>
  );
  const pickShape = (kind: ShapeKind, close: () => void) => {
    c.setToolOptions({ shape: kind });
    c.setTool('shape');
    close();
  };

  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-orientation="horizontal" aria-label={tt.label}>
      {button('select', tt.select, <MousePointer2 />)}
      {button('hand', tt.hand, <Hand />)}
      {!ro && (
        <>
          <Divider />
          <BarPopover
            label={tt.sticky}
            keys={TOOL_SHORTCUTS.sticky}
            tooltipSide="bottom"
            className={TOOL_BUTTON}
            active={tool === 'sticky'}
            dragTool="sticky"
            trigger={<StickyNote style={{ color: tool === 'sticky' ? undefined : '#ca8a04' }} />}
          >
            {(close) => (
              <Swatches
                colors={STICKY_COLORS}
                value={c.toolOptions.stickyColor}
                onPick={(color) => {
                  if (color) c.setToolOptions({ stickyColor: color });
                  c.setTool('sticky');
                  close();
                }}
              />
            )}
          </BarPopover>
          <BarPopover label={tt.shape} keys={TOOL_SHORTCUTS.shape} tooltipSide="bottom" className={TOOL_BUTTON} active={tool === 'shape'} dragTool="shape" trigger={<Shapes />}>
            {(close) => (
              <div className="flex w-72 flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">{ts.basic}</p>
                <ShapeGrid items={BASIC_SHAPES.map((kind) => [kind, ts[kind]])} value={tool === 'shape' ? c.toolOptions.shape : undefined} onPick={(kind) => pickShape(kind, close)} />
                <p className="text-xs font-medium text-muted-foreground">{ts.flowchart}</p>
                <ShapeGrid
                  items={FLOW_SHAPES.map(([kind, name]) => [kind, ts[name]])}
                  // A kind that is also a basic shape is marked there only.
                  value={tool === 'shape' && !BASIC_SHAPES.includes(c.toolOptions.shape) ? c.toolOptions.shape : undefined}
                  onPick={(kind) => pickShape(kind, close)}
                />
              </div>
            )}
          </BarPopover>
          {button('text', tt.text, <Type />)}
          <ConnectorPicker controller={c} label={tt.connector} />
          {/* Drawing: opening it picks the drawing tool used last; the others and its options are inside */}
          <BarPopover
            label={tt.drawing}
            keys={TOOL_SHORTCUTS.pen}
            tooltipSide="bottom"
            className={TOOL_BUTTON}
            active={isDrawingTool(tool)}
            trigger={drawingIcon(drawing)}
            onOpenChange={(open) => open && c.setTool(drawing)}
          >
            {(close) => (
              <div className="flex w-64 flex-col gap-2">
                <div className="flex gap-1">
                  <BarButton label={tt.pen} keys={TOOL_SHORTCUTS.pen} active={tool === 'pen'} onClick={pick('pen')}>
                    <Pencil />
                  </BarButton>
                  <BarButton label={tt.highlighter} keys={['shift', 'P']} active={tool === 'highlighter'} onClick={pick('highlighter')}>
                    <Highlighter />
                  </BarButton>
                  <BarButton label={tt.eraser} keys={TOOL_SHORTCUTS.eraser} active={tool === 'eraser'} onClick={pick('eraser')}>
                    <Eraser />
                  </BarButton>
                </div>
                {drawing === 'pen' && (
                  <>
                    <Swatches
                      colors={PALETTE}
                      value={c.toolOptions.penColor}
                      onPick={(color) => {
                        if (!color) return;
                        c.setToolOptions({ penColor: color });
                        c.setTool('pen');
                        close();
                      }}
                    />
                    <div className="flex items-center gap-2" role="group" aria-label={tt.penWidth}>
                      {PEN_WIDTHS.map(([w, dot]) => (
                        <button
                          key={w}
                          type="button"
                          aria-label={`${w} px`}
                          title={`${tt.penWidth}: ${w} px`}
                          aria-pressed={c.toolOptions.penWidth === w}
                          className={cn('flex size-8 items-center justify-center rounded-md hover:bg-accent', c.toolOptions.penWidth === w && 'bg-accent')}
                          onClick={() => c.setToolOptions({ penWidth: w })}
                        >
                          <span className="rounded-full bg-foreground" style={{ width: dot, height: dot }} />
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {drawing === 'highlighter' && (
                  <Swatches
                    colors={['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74', '#c4b5fd']}
                    value={c.toolOptions.highlighterColor}
                    onPick={(color) => {
                      if (!color) return;
                      c.setToolOptions({ highlighterColor: color });
                      c.setTool('highlighter');
                      close();
                    }}
                  />
                )}
              </div>
            )}
          </BarPopover>
          {button('frame', tt.frame, <Frame />)}
          {button('card', tt.card, <SquareKanban />)}
          {button('mindmap', tt.mindmap, <Network />)}
          <BarButton label={tt.image} side="bottom" className={TOOL_BUTTON} onClick={onImage}>
            <ImagePlus />
          </BarButton>
          {onFile && (
            <BarButton label={tt.file} side="bottom" className={TOOL_BUTTON} onClick={onFile}>
              <Paperclip />
            </BarButton>
          )}
          <Divider />
          <BarButton label={tt.templates} side="bottom" className={TOOL_BUTTON} onClick={onTemplates}>
            <LayoutTemplate />
          </BarButton>
          {onRecords && (
            <BarButton label={tt.records} side="bottom" className={TOOL_BUTTON} onClick={onRecords}>
              <Database />
            </BarButton>
          )}
        </>
      )}
      {(!ro || c.canComment) && (
        <>
          <Divider />
          {button('comment', tt.comment, <MessageSquarePlus />)}
        </>
      )}
    </div>
  );
}

export function ShapeGrid({ items, value, onPick }: { items: [ShapeKind, string][]; value?: ShapeKind; onPick: (kind: ShapeKind) => void }) {
  return (
    <div className="grid grid-cols-6 gap-1">
      {items.map(([kind, name]) => (
        <button
          key={`${kind}-${name}`}
          type="button"
          title={name}
          aria-label={name}
          aria-pressed={value === kind}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(kind)}
          className={cn('flex size-10 items-center justify-center rounded-md hover:bg-accent', value === kind && 'bg-accent')}
        >
          <ShapeIcon kind={kind} className="size-6" />
        </button>
      ))}
    </div>
  );
}

/** How each connector route runs, drawn from corner to corner. */
const ROUTE_PATHS: Record<ConnectorRoute, string> = {
  straight: 'M5 19 L19 5',
  elbow: 'M5 19 H12 V5 H19',
  curved: 'M5 19 C5 9 19 15 19 5',
};

function RouteIcon({ route }: { route: ConnectorRoute }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ROUTE_PATHS[route]} />
      <circle cx="5" cy="19" r="1.5" fill="currentColor" />
      <circle cx="19" cy="5" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** The connector tool, a panel like the other tools': opening it picks the tool, and inside is how connectors run. */
function ConnectorPicker({ controller: c, label }: { controller: BoardController; label: string }) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.connector;
  const routes: [ConnectorRoute, string][] = [
    ['straight', tc.straight],
    ['elbow', tc.elbow],
    ['curved', tc.curved],
  ];
  return (
    <BarPopover
      label={label}
      keys={TOOL_SHORTCUTS.connector}
      tooltipSide="bottom"
      className={TOOL_BUTTON}
      active={c.tool === 'connector'}
      trigger={<Spline />}
      onOpenChange={(open) => open && c.setTool('connector')}
    >
      {(close) => (
        <div className="flex gap-1" role="group" aria-label={tc.route}>
          {routes.map(([route, name]) => (
            <BarButton
              key={route}
              label={name}
              active={c.toolOptions.connectorRoute === route}
              onClick={() => {
                c.setToolOptions({ connectorRoute: route });
                c.setTool('connector');
                close();
              }}
            >
              <RouteIcon route={route} />
            </BarButton>
          ))}
        </div>
      )}
    </BarPopover>
  );
}

export function UndoRedo({ controller: c }: { controller: BoardController }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  return (
    <div className="flex items-center gap-0.5">
      <BarButton label={te.undo} keys={['mod', 'Z']} side="bottom" onClick={() => c.undo()} disabled={c.readOnly || !c.history.canUndo}>
        <Undo2 />
      </BarButton>
      <BarButton label={te.redo} keys={['mod', 'shift', 'Z']} side="bottom" onClick={() => c.redo()} disabled={c.readOnly || !c.history.canRedo}>
        <Redo2 />
      </BarButton>
    </div>
  );
}
