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
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { BoardController } from './model/board-controller';
import type { ToolKind } from './model/tools';
import { BarButton, BarPopover, Divider, Swatches, TOOL_BUTTON } from './ui';

const BASIC: ShapeKind[] = ['rectangle', 'rounded', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'cross', 'parallelogram', 'trapezoid', 'cloud', 'callout', 'arrow-right', 'arrow-left', 'chevron', 'cylinder'];
const FLOW: ShapeKind[] = ['terminator', 'rectangle', 'diamond', 'data', 'document', 'predefined', 'delay', 'manual-input', 'cylinder'];

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
  const ro = c.readOnly;

  const pick = (next: ToolKind) => () => c.setTool(next);
  const lock = (next: ToolKind) => () => c.setTool(next, true);
  const button = (kind: ToolKind, label: string, icon: ReactNode, disabled = false) => (
    <BarButton key={kind} label={label} side="right" className={TOOL_BUTTON} active={tool === kind} disabled={disabled} onClick={pick(kind)} onDoubleClick={lock(kind)}>
      {icon}
    </BarButton>
  );

  return (
    <div className="pointer-events-auto flex flex-col items-center gap-0.5 rounded-xl border bg-background p-1 shadow-md" role="toolbar" aria-orientation="vertical">
      {button('select', tt.select, <MousePointer2 />)}
      {button('hand', tt.hand, <Hand />)}
      {!ro && (
        <>
          <Divider vertical={false} />
          <BarPopover label={tt.sticky} side="right" className={TOOL_BUTTON} active={tool === 'sticky'} trigger={<StickyNote style={{ color: tool === 'sticky' ? undefined : '#ca8a04' }} />}>
            <div className="flex w-64 flex-col gap-2">
              <button type="button" className="rounded-md bg-primary px-2 py-1.5 text-sm text-primary-foreground" onClick={pick('sticky')}>
                {tt.sticky}
              </button>
              <Swatches
                colors={STICKY_COLORS}
                value={c.toolOptions.stickyColor}
                onPick={(color) => {
                  if (color) c.setToolOptions({ stickyColor: color });
                  c.setTool('sticky');
                }}
              />
            </div>
          </BarPopover>
          <BarPopover label={tt.shape} side="right" className={TOOL_BUTTON} active={tool === 'shape'} trigger={<Shapes />}>
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
          <BarPopover label={tt.connector} side="right" className={TOOL_BUTTON} active={tool === 'connector'} trigger={<Spline />}>
            <ConnectorOptions controller={c} />
          </BarPopover>
          <BarPopover label={tt.drawing} side="right" className={TOOL_BUTTON} active={tool === 'pen' || tool === 'highlighter' || tool === 'eraser'} trigger={tool === 'highlighter' ? <Highlighter /> : tool === 'eraser' ? <Eraser /> : <Pencil />}>
            <div className="flex w-64 flex-col gap-2">
              <div className="flex gap-1">
                <BarButton label={tt.pen} active={tool === 'pen'} onClick={pick('pen')}>
                  <Pencil />
                </BarButton>
                <BarButton label={tt.highlighter} active={tool === 'highlighter'} onClick={pick('highlighter')}>
                  <Highlighter />
                </BarButton>
                <BarButton label={tt.eraser} active={tool === 'eraser'} onClick={pick('eraser')}>
                  <Eraser />
                </BarButton>
              </div>
              <Swatches
                colors={tool === 'highlighter' ? ['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74', '#c4b5fd'] : PALETTE}
                value={tool === 'highlighter' ? c.toolOptions.highlighterColor : c.toolOptions.penColor}
                onPick={(color) => {
                  if (!color) return;
                  if (tool === 'highlighter') c.setToolOptions({ highlighterColor: color });
                  else {
                    c.setToolOptions({ penColor: color });
                    if (tool !== 'pen') c.setTool('pen');
                  }
                }}
              />
              {tool !== 'highlighter' && (
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
              )}
            </div>
          </BarPopover>
          {button('frame', tt.frame, <Frame />)}
          {button('card', tt.card, <SquareKanban />)}
          {button('mindmap', tt.mindmap, <Network />)}
          <BarButton label={tt.image} side="right" className={TOOL_BUTTON} onClick={onImage}>
            <ImagePlus />
          </BarButton>
          {onFile && (
            <BarButton label={tt.file} side="right" className={TOOL_BUTTON} onClick={onFile}>
              <Paperclip />
            </BarButton>
          )}
          <Divider vertical={false} />
          <BarButton label={tt.templates} side="right" className={TOOL_BUTTON} onClick={onTemplates}>
            <LayoutTemplate />
          </BarButton>
          {onRecords && (
            <BarButton label={tt.records} side="right" className={TOOL_BUTTON} onClick={onRecords}>
              <Database />
            </BarButton>
          )}
          {onAi && (
            <BarButton label={tt.ai} side="right" className={TOOL_BUTTON} onClick={onAi}>
              <Sparkles className="text-violet-600" />
            </BarButton>
          )}
        </>
      )}
      {(!ro || c.canComment) && (
        <>
          <Divider vertical={false} />
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

function ConnectorOptions({ controller: c }: { controller: BoardController }) {
  const { t } = useI18n();
  const tc = t.weldboard.editor.connector;
  const routes: [ConnectorRoute, string][] = [
    ['straight', tc.straight],
    ['elbow', tc.elbow],
    ['curved', tc.curved],
  ];
  return (
    <div className="flex w-48 flex-col gap-1">
      {routes.map(([route, label]) => (
        <button
          key={route}
          type="button"
          className={cn('rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', c.tool === 'connector' && c.toolOptions.connectorRoute === route && 'bg-accent')}
          onClick={() => {
            c.setToolOptions({ connectorRoute: route });
            c.setTool('connector');
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function UndoRedo({ controller: c }: { controller: BoardController }) {
  const { t } = useI18n();
  const te = t.weldboard.editor;
  return (
    <div className="pointer-events-auto flex items-center gap-0.5 rounded-xl border bg-background p-1 shadow-md">
      <BarButton label={te.undo} onClick={() => c.undo()} disabled={c.readOnly || !c.history.canUndo}>
        <Undo2 />
      </BarButton>
      <BarButton label={te.redo} onClick={() => c.redo()} disabled={c.readOnly || !c.history.canRedo}>
        <Redo2 />
      </BarButton>
    </div>
  );
}
