/**
 * The board model: plain JSON, so elements travel over the collaboration
 * socket, sit in the op log and in checkpoints unchanged.
 *
 * An element is a flat record. Every property is its own key (no nested
 * style object), so two people changing different properties of one element
 * at the same time both keep their change: concurrent `set` ops conflict
 * only on the same key (see ops/transform.ts).
 *
 * Coordinates are absolute board units for every element, also for the
 * children of a frame or group. Moving a frame moves its children through
 * their own `set` ops, so a child never depends on its parent's geometry.
 */

export const ELEMENT_TYPES = [
  'sticky',
  'shape',
  'text',
  'connector',
  'pen',
  'image',
  'file',
  'frame',
  'group',
  'card',
  'record',
  'link',
  'comment',
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const SHAPE_KINDS = [
  'rectangle',
  'rounded',
  'ellipse',
  'triangle',
  'diamond',
  'parallelogram',
  'trapezoid',
  'pentagon',
  'hexagon',
  'octagon',
  'star',
  'cross',
  'cylinder',
  'cloud',
  'callout',
  'arrow-right',
  'arrow-left',
  'chevron',
  'document',
  'predefined',
  'data',
  'terminator',
  'delay',
  'manual-input',
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

export type StrokeStyle = 'solid' | 'dashed' | 'dotted';
export type TextAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';
export type ConnectorRoute = 'straight' | 'elbow' | 'curved';
export type Cap = 'none' | 'arrow' | 'triangle' | 'circle' | 'diamond' | 'bar';
export type Side = 'top' | 'right' | 'bottom' | 'left';
export type PenKind = 'pen' | 'highlighter';
export type RecordKind = 'task' | 'project' | 'company' | 'person' | 'opportunity' | 'ticket';

/** Inline formatting of a stretch of text. Short keys: text is stored and sent a lot. */
export interface Marks {
  /** Bold. */
  b?: true;
  /** Italic. */
  i?: true;
  /** Underline. */
  u?: true;
  /** Strikethrough. */
  s?: true;
  /** Text colour. */
  c?: string;
  /** Highlight colour. */
  h?: string;
  /** Link target. */
  a?: string;
  /** A mentioned member's user id (the text is their name). */
  m?: string;
}

/** `[length, marks]`; runs cover the whole text, in order. */
export type MarkRun = [number, Marks];

/**
 * Text inside a sticky, shape, text box, card, frame title or connector
 * label. Paragraphs are separated by `\n`. `marks` covers `text` exactly;
 * an empty array means no formatting anywhere.
 */
export interface RichText {
  text: string;
  marks: MarkRun[];
}

/**
 * One end of a connector. `x`/`y` is always set: it is where the end is
 * drawn when it is free, or when the element it is bound to is gone. A bound
 * end follows its element: on one side (`side`), or at a point inside its
 * box (`rx`/`ry`, 0–1).
 */
export interface ConnectorEnd {
  x: number;
  y: number;
  el?: string;
  side?: Side | 'auto';
  rx?: number;
  ry?: number;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A WeldSuite record shown live on the board. */
export interface RecordRef {
  kind: RecordKind;
  id: string;
}

/** Mind-map membership: the root's id, the parent node and the side it grows to. */
export interface MindMapInfo {
  root: string;
  parent?: string;
  side?: 'left' | 'right';
  collapsed?: boolean;
}

export interface BoardElement {
  id: string;
  type: ElementType;
  /** A frame or group this element sits in; absent or null at the top level. */
  parent?: string | null;
  /** Fractional index among its siblings: higher draws on top. */
  order: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians, clockwise, around the box's centre. */
  rotation?: number;
  locked?: boolean;
  link?: string;
  createdBy?: string;
  createdAt?: number;

  // Style
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  strokeStyle?: StrokeStyle;
  opacity?: number;
  fontFamily?: string;
  fontSize?: number;
  textColor?: string;
  textAlign?: TextAlign;
  vAlign?: VerticalAlign;
  /** Shrink the text to fit the box (stickies). */
  autoFit?: boolean;

  // Content
  text?: RichText;

  // shape
  shape?: ShapeKind;
  /** Corner radius (rectangles, cards, frames). */
  radius?: number;

  // pen: flat [x, y, pressure, x, y, pressure, …] relative to (x, y)
  points?: number[];
  pen?: PenKind;

  // connector
  start?: ConnectorEnd;
  end?: ConnectorEnd;
  route?: ConnectorRoute;
  startCap?: Cap;
  endCap?: Cap;
  /** Curved connectors: a point the curve passes through (absolute). */
  control?: { x: number; y: number } | null;
  /** Where along the connector its label sits, 0–1. */
  labelAt?: number;

  // image / file
  /** `drive:<fileId>` for a WeldDrive file, or an https address. */
  src?: string;
  crop?: Crop | null;
  fileName?: string;
  mime?: string;
  size?: number;
  alt?: string;

  // frame
  name?: string;
  /** Position in presentation order; absent means not a slide. */
  slide?: number;
  /** Frames: whether to clip content to the frame. */
  clip?: boolean;

  // card
  description?: string;
  assignee?: string | null;
  due?: string | null;
  tags?: string[];

  // record
  record?: RecordRef;

  // link card
  title?: string;
  image?: string;
  siteName?: string;

  // comment pin
  thread?: string;
  resolved?: boolean;
  /** The element a comment pin is attached to. */
  target?: string;

  // mind map
  mindmap?: MindMapInfo;
}

/** A running or paused timer on the board, shared by everyone on it. */
export interface BoardTimer {
  /** Length set, ms. */
  duration: number;
  /** When it ends (epoch ms) while running. */
  endsAt?: number;
  /** Time left while paused, ms. */
  remaining?: number;
  startedBy?: string;
}

/** A voting session: who voted for what. */
export interface VotingSession {
  id: string;
  /** Votes each person has. */
  votesPerPerson: number;
  /** Hide who voted for what until it ends. */
  anonymous: boolean;
  /** Only these elements can be voted on (absent: every sticky, shape and card). */
  scope?: string[];
  status: 'open' | 'closed';
  startedBy?: string;
  title?: string;
}

export interface BoardProps {
  background?: string;
  grid?: 'dots' | 'lines' | 'none';
  timer?: BoardTimer | null;
  voting?: VotingSession | null;
  /** Nobody but owners may move or change elements. */
  locked?: boolean;
  /** Stickies hidden from others until revealed (private mode). */
  privateMode?: boolean;
}

export const SNAPSHOT_VERSION = 1;

/** A whole board as JSON, deterministic: equal boards give equal snapshots. */
export interface BoardSnapshot {
  version: number;
  props: BoardProps;
  /** Sorted by id. */
  elements: BoardElement[];
  /** Votes of the current session, by user id, each a list of element ids (repeats allowed). */
  votes?: Record<string, string[]>;
}

/** Keys every element has. */
export const REQUIRED_KEYS = ['id', 'type', 'order', 'x', 'y', 'w', 'h'] as const;
