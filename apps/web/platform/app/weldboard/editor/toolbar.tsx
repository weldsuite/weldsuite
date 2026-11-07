import type { ReactNode } from 'react';
import {
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
  Sparkles,
  Spline,
  SquareKanban,
  StickyNote,
  Type,
  Undo2,
  Database,
} from 'lucide-react';
import { pathToSvg, shapeOutline, STICKY_COLORS, PALETTE, type ConnectorRoute, type ShapeKind } from '@weldsuite/board-engine';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import { DROPPABLE_TOOLS, isDrawingTool, type DrawingTool, type ToolKind } from './model/tools';
import { Swatches } from './swatches';
import { BarButton, BarPopover, Divider, TOOL_BUTTON, WithTooltip } from './ui';

const BASIC: ShapeKind[] = ['rectangle', 'rounded', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'cross', 'parallelogram', 'trapezoid', 'cloud', 'callout', 'arrow-right', 'arrow-left', 'chevron', 'cylinder'];
const FLOW: ShapeKind[] = ['terminator', 'rectangle', 'diamond', 'data', 'document', 'predefined', 'delay', 'manual-input', 'cylinder'];

/** The drawing button shows the drawing tool it picks. */
function drawingIcon(tool: DrawingTool): ReactNode {
  if (tool === 'highlighter') return <Highlighter />;
  if (tool === 'eraser') return <Eraser />;
  return <Pencil />;
}

export function ShapeIcon({ kind, className }: { kind: ShapeKind; className?: string }) {
  return (
    <svg viewBox="-2 -2 28 24" className={cn('size-5', className)} aria-hidden>
      <path d={pathToSvg(shapeOutline(kind, 24, 20, kind === 'rounded' ? 5 : 0))} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
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
  onAi?: () => void;
}

export function Toolbar({ controller: c, onImage, onFile, onTemplates, onRecords, onAi }: ToolbarProps) {
  const { t } = useI18n();
  const tt = t.weldboard.editor.tools;
  const ts = t.weldboard.editor.shapes;
  const tool = c.tool;
  const drawing = c.toolOptions.drawingTool;
  const ro = c.readOnly;

  const pick = (next: ToolKind) => () => c.setTool(next);
  const lock = (next: ToolKind) => () => c.setTool(next, true);
  const button = (kind: ToolKind, label: string, icon: ReactNode, disabled = false) => (
    <BarButton key={kind} label={label} side="bottom" className={TOOL_BUTTON} active={tool === kind} disabled={disabled} onClick={pick(kind)} onDoubleClick={lock(kind)} dragTool={DROPPABLE_TOOLS.has(kind) ? kind : undefined}>
      {icon}
    </BarButton>
  );

  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-orientation="horizontal">
      {button('select', tt.select, <MousePointer2 />)}
      {button('hand', tt.hand, <Hand />)}
      {!ro && (
        <>
          <Divider />
          <BarPopover label={tt.sticky} side="bottom" className={TOOL_BUTTON} active={tool === 'sticky'} dragTool="sticky" trigger={<StickyNote style={{ color: tool === 'sticky' ? undefined : '#ca8a04' }} />}>
            <Swatches
              colors={STICKY_COLORS}
              value={c.toolOptions.stickyColor}
              onPick={(color) => {
                if (color) c.setToolOptions({ stickyColor: color });
                c.setTool('sticky');
              }}
            />
          </BarPopover>
          <BarPopover label={tt.shape} side="bottom" className={TOOL_BUTTON} active={tool === 'shape'} dragTool="shape" trigger={<Shapes />}>
            <div className="flex w-72 flex-col gap-2">
              <p className="text-xs font-medium text-muted-foreground">{ts.basic}</p>
              <ShapeGrid kinds={BASIC} value={tool === 'shape' ? c.toolOptions.shape : undefined} labels={ts} onPick={(kind) => {
                c.setToolOptions({ shape: kind });
                c.setTool('shape');
              }} />
              <p className="text-xs font-medium text-muted-foreground">{ts.flowchart}</p>
              <ShapeGrid kinds={FLOW} value={undefined} labels={ts} onPick={(kind) => {
                c.setToolOptions({ shape: kind });
                c.setTool('shape');
              }} />
            </div>
          </BarPopover>
          {button('text', tt.text, <Type />)}
          <ConnectorMenu controller={c} label={tt.connector} />
          {/* Drawing: opening it picks the drawing tool used last; the others and its options are inside */}
          <BarPopover label={tt.drawing} side="bottom" className={TOOL_BUTTON} active={isDrawingTool(tool)} trigger={drawingIcon(drawing)} onOpenChange={(open) => open && c.setTool(drawing)}>
            <div className="flex w-64 flex-col gap-2">
              <div className="flex gap-1">
                <BarButton label={tt.pen} active={drawing === 'pen'} onClick={pick('pen')}>
                  <Pencil />
                </BarButton>
                <BarButton label={tt.highlighter} active={drawing === 'highlighter'} onClick={pick('highlighter')}>
                  <Highlighter />
                </BarButton>
                <BarButton label={tt.eraser} active={drawing === 'eraser'} onClick={pick('eraser')}>
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
                    }}
                  />
                  <div className="flex items-center gap-2">
                    {[2, 3, 5, 8, 12].map((w) => (
                      <button
                        key={w}
                        type="button"
                        aria-label={`${w}`}
                        className={cn('flex size-8 items-center justify-center rounded-md hover:bg-accent', c.toolOptions.penWidth === w && 'bg-accent')}
                        onClick={() => c.setToolOptions({ penWidth: w })}
                      >
                        <span className="rounded-full bg-foreground" style={{ width: w + 2, height: w + 2 }} />
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
                  }}
                />
              )}
            </div>
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
          {onAi && (
            <BarButton label={tt.ai} side="bottom" className={TOOL_BUTTON} onClick={onAi}>
              <Sparkles className="text-violet-600" />
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

function ShapeGrid({ kinds, value, onPick, labels }: { kinds: ShapeKind[]; value?: ShapeKind; onPick: (kind: ShapeKind) => void; labels: Record<string, string> }) {
  return (
    <div className="grid grid-cols-6 gap-1">
      {kinds.map((kind, i) => (
        <button
          key={`${kind}-${i}`}
          type="button"
          title={labels[kind]}
          aria-label={labels[kind]}
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

/** The connector tool: picks how connectors run, as a stock shadcn menu. */
function ConnectorMenu({ controller: c, label }: { controller: BoardController; label: string }) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.connector;
  const routes: [ConnectorRoute, string][] = [
    ['straight', tc.straight],
    ['elbow', tc.elbow],
    ['curved', tc.curved],
  ];
  const active = c.tool === 'connector';
  return (
    <DropdownMenu>
      <WithTooltip label={label} side="bottom">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(TOOL_BUTTON, 'aria-expanded:bg-accent', active && 'bg-primary/10 text-primary aria-expanded:bg-primary/15')}
            onMouseDown={(e) => e.preventDefault()}
          >
            <Spline />
          </button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="start" className="min-w-0" onCloseAutoFocus={(e) => e.preventDefault()}>
        {/* Stock items side by side, icons only; the current route keeps the item highlight. */}
        <DropdownMenuGroup className="flex">
          {routes.map(([route, name]) => (
            <DropdownMenuItem
              key={route}
              aria-label={name}
              title={name}
              className={cn(c.toolOptions.connectorRoute === route && 'bg-accent text-accent-foreground')}
              onSelect={() => {
                c.setToolOptions({ connectorRoute: route });
                c.setTool('connector');
              }}
            >
              <RouteIcon route={route} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UndoRedo({ controller: c }: { controller: BoardController }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  return (
    <div className="flex items-center gap-0.5">
      <BarButton label={te.undo} onClick={() => c.undo()} disabled={c.readOnly || !c.history.canUndo}>
        <Undo2 />
      </BarButton>
      <BarButton label={te.redo} onClick={() => c.redo()} disabled={c.readOnly || !c.history.canRedo}>
        <Redo2 />
      </BarButton>
    </div>
  );
}
