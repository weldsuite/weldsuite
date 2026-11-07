import { STICKY_COLORS, type Cap, type ConnectorRoute, type ShapeKind } from '@weldsuite/board-engine';

export type ToolKind =
  | 'select'
  | 'hand'
  | 'sticky'
  | 'shape'
  | 'text'
  | 'connector'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'frame'
  | 'card'
  | 'comment'
  | 'mindmap';

export interface ToolOptions {
  shape: ShapeKind;
  stickyColor: string;
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  connectorRoute: ConnectorRoute;
  endCap: Cap;
  shapeFill: string;
  /** The drawing tool used last, which the drawing button picks. */
  drawingTool: DrawingTool;
}

export type DrawingTool = 'pen' | 'highlighter' | 'eraser';

export function isDrawingTool(tool: ToolKind): tool is DrawingTool {
  return tool === 'pen' || tool === 'highlighter' || tool === 'eraser';
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  shape: 'rectangle',
  stickyColor: STICKY_COLORS[0],
  penColor: '#1f2937',
  penWidth: 3,
  highlighterColor: '#fde047',
  connectorRoute: 'elbow',
  endCap: 'arrow',
  shapeFill: '#ffffff',
  drawingTool: 'pen',
};

/** Tools that can be dragged from the toolbar onto the board; a drop makes what a click there makes. */
export const DROPPABLE_TOOLS: ReadonlySet<ToolKind> = new Set<ToolKind>(['sticky', 'shape', 'text', 'frame', 'card', 'mindmap']);

/** The drag data type of a tool dragged from the toolbar. */
export const TOOL_DRAG_TYPE = 'application/x-weldboard-tool';

/** Single-key shortcuts for tools (Miro's where they exist). */
export const TOOL_KEYS: Record<string, ToolKind> = {
  v: 'select',
  h: 'hand',
  n: 'sticky',
  s: 'shape',
  r: 'shape',
  t: 'text',
  l: 'connector',
  p: 'pen',
  e: 'eraser',
  f: 'frame',
  c: 'comment',
  m: 'mindmap',
};

/** Tools that draw on a read-only board (none edit it). */
export const READ_ONLY_TOOLS: ReadonlySet<ToolKind> = new Set(['select', 'hand', 'comment']);
