/**
 * What each element and board property may hold. The room trusts nothing a
 * browser sends, so every op is checked key by key against this table
 * before it is applied (ops/shape.ts), which also keeps snapshots loadable.
 */

import { isOrderKey } from './order';
import { isRichText } from './text';
import {
  ELEMENT_TYPES,
  SHAPE_KINDS,
  type BoardElement,
  type BoardProps,
  type ConnectorEnd,
  type ElementType,
} from './types';

type Check = (v: unknown) => boolean;

export const MAX_COORD = 10_000_000;
export const MAX_SIZE = 1_000_000;
export const MAX_POINTS = 30_000;
export const MAX_ELEMENTS = 100_000;
export const MAX_ID = 64;

const ID_RE = /^[A-Za-z0-9_:-]+$/;

export function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && ID_RE.test(v);
}

const num =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const int =
  (min: number, max: number): Check =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const str =
  (max: number, min = 0): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max;
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const bool: Check = (v) => typeof v === 'boolean';
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);

const COLOR_RE = /^[#a-zA-Z0-9(),.\s%-]{1,64}$/;
export const isColor: Check = (v) => typeof v === 'string' && COLOR_RE.test(v);

const coord = num(-MAX_COORD, MAX_COORD);
const unit = num(0, 1);

function isPoint(v: unknown): v is { x: number; y: number } {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return Object.keys(p).length === 2 && coord(p.x) && coord(p.y);
}

const SIDES = ['top', 'right', 'bottom', 'left', 'auto'] as const;

export function isConnectorEnd(v: unknown): v is ConnectorEnd {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  for (const k of Object.keys(e)) if (!['x', 'y', 'el', 'side', 'rx', 'ry'].includes(k)) return false;
  return (
    coord(e.x) &&
    coord(e.y) &&
    (e.el === undefined || isId(e.el)) &&
    (e.side === undefined || oneOf(SIDES)(e.side)) &&
    (e.rx === undefined || unit(e.rx)) &&
    (e.ry === undefined || unit(e.ry))
  );
}

/** Images: a WeldDrive file, an https address, or (signed-out preview only) an inline image. */
export const isImageSrc: Check = (v) =>
  typeof v === 'string' &&
  ((v.startsWith('drive:') && isId(v.slice(6))) ||
    (v.startsWith('https://') && v.length <= 4096) ||
    // Local development: app-api on localhost serves uploads over http.
    ((v.startsWith('http://localhost:') || v.startsWith('http://127.0.0.1:')) && v.length <= 4096) ||
    (v.startsWith('data:image/') && v.length <= 2_000_000));

const isUrl: Check = (v) => typeof v === 'string' && v.length <= 2048 && /^(https?:|mailto:|\/)/i.test(v);

function isCrop(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return Object.keys(c).length === 4 && unit(c.x) && unit(c.y) && unit(c.w) && unit(c.h);
}

function isRecordRef(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Object.keys(r).length === 2 &&
    oneOf(['task', 'project', 'company', 'person', 'opportunity', 'ticket'])(r.kind) &&
    isId(r.id)
  );
}

function isMindMap(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!['root', 'parent', 'side', 'collapsed'].includes(k)) return false;
  return (
    isId(m.root) &&
    (m.parent === undefined || isId(m.parent)) &&
    (m.side === undefined || oneOf(['left', 'right'])(m.side)) &&
    (m.collapsed === undefined || bool(m.collapsed))
  );
}

function isPoints(v: unknown): boolean {
  if (!Array.isArray(v) || v.length % 3 !== 0 || v.length > MAX_POINTS * 3) return false;
  for (const n of v) if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_COORD) return false;
  return true;
}

const isTags: Check = (v) => Array.isArray(v) && v.length <= 20 && v.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 64);

/** Every element property and what it may hold. `type` and `id` are only set on create. */
export const ELEMENT_KEYS: Record<keyof BoardElement, Check> = {
  id: isId,
  type: oneOf(ELEMENT_TYPES),
  parent: nullable(isId),
  order: isOrderKey,
  x: coord,
  y: coord,
  w: num(0, MAX_SIZE),
  h: num(0, MAX_SIZE),
  rotation: num(-100, 100),
  locked: bool,
  link: isUrl,
  createdBy: str(128, 1),
  createdAt: num(0, 1e15),
  fill: isColor,
  stroke: isColor,
  strokeWidth: num(0, 200),
  strokeStyle: oneOf(['solid', 'dashed', 'dotted']),
  opacity: unit,
  fontFamily: str(64, 1),
  fontSize: num(1, 1000),
  textColor: isColor,
  textAlign: oneOf(['left', 'center', 'right']),
  vAlign: oneOf(['top', 'middle', 'bottom']),
  autoFit: bool,
  text: isRichText,
  shape: oneOf(SHAPE_KINDS),
  radius: num(0, MAX_SIZE),
  points: isPoints,
  pen: oneOf(['pen', 'highlighter']),
  start: isConnectorEnd,
  end: isConnectorEnd,
  route: oneOf(['straight', 'elbow', 'curved']),
  startCap: oneOf(['none', 'arrow', 'triangle', 'circle', 'diamond', 'bar']),
  endCap: oneOf(['none', 'arrow', 'triangle', 'circle', 'diamond', 'bar']),
  control: nullable(isPoint),
  labelAt: unit,
  src: isImageSrc,
  crop: nullable(isCrop),
  fileName: str(512, 1),
  mime: str(128, 1),
  size: num(0, 1e13),
  alt: str(1000),
  name: str(200),
  slide: int(0, 100_000),
  clip: bool,
  description: str(5000),
  assignee: nullable(str(128, 1)),
  due: nullable(str(32, 1)),
  tags: isTags,
  record: isRecordRef,
  title: str(500),
  image: isImageSrc,
  siteName: str(200),
  thread: isId,
  resolved: bool,
  target: isId,
  mindmap: isMindMap,
};

/** Keys a `set` may not change. */
export const IMMUTABLE_KEYS: ReadonlySet<string> = new Set(['id', 'type']);
/** Keys a `set` may not remove (null removes a key, except `parent`, where null means the top level). */
export const REQUIRED: ReadonlySet<string> = new Set(['id', 'type', 'order', 'x', 'y', 'w', 'h']);

/** Which keys make sense on which type (others are refused, keeping snapshots tidy). */
const COMMON = new Set([
  'id', 'type', 'parent', 'order', 'x', 'y', 'w', 'h', 'rotation', 'locked', 'link', 'createdBy', 'createdAt', 'opacity',
]);
const TEXT_STYLE = ['text', 'fontFamily', 'fontSize', 'textColor', 'textAlign', 'vAlign', 'autoFit'];
const BOX_STYLE = ['fill', 'stroke', 'strokeWidth', 'strokeStyle', 'radius'];

const TYPE_KEYS: Record<ElementType, ReadonlySet<string>> = {
  sticky: new Set([...COMMON, ...TEXT_STYLE, 'fill', 'mindmap', 'tags']),
  shape: new Set([...COMMON, ...TEXT_STYLE, ...BOX_STYLE, 'shape', 'mindmap']),
  text: new Set([...COMMON, ...TEXT_STYLE, 'fill', 'mindmap']),
  connector: new Set([
    ...COMMON, 'text', 'fontFamily', 'fontSize', 'textColor', 'stroke', 'strokeWidth', 'strokeStyle',
    'start', 'end', 'route', 'startCap', 'endCap', 'control', 'labelAt',
  ]),
  pen: new Set([...COMMON, 'stroke', 'strokeWidth', 'points', 'pen']),
  image: new Set([...COMMON, 'src', 'crop', 'alt', 'fileName', 'stroke', 'strokeWidth', 'radius']),
  file: new Set([...COMMON, 'src', 'fileName', 'mime', 'size', 'fill']),
  frame: new Set([...COMMON, 'name', 'fill', 'stroke', 'slide', 'clip', 'radius']),
  group: new Set([...COMMON]),
  card: new Set([...COMMON, ...TEXT_STYLE, 'fill', 'stroke', 'description', 'assignee', 'due', 'tags', 'radius']),
  record: new Set([...COMMON, 'record', 'fill']),
  link: new Set([...COMMON, 'title', 'description', 'image', 'siteName', 'fill']),
  comment: new Set([...COMMON, 'thread', 'resolved', 'target']),
};

export function keyAllowed(type: ElementType, key: string): boolean {
  return TYPE_KEYS[type].has(key);
}

/** A complete, well-formed element. */
export function isElement(v: unknown): v is BoardElement {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const el = v as Record<string, unknown>;
  if (!ELEMENT_KEYS.type(el.type)) return false;
  for (const k of REQUIRED) if (!(k in el)) return false;
  const type = el.type as ElementType;
  for (const [k, val] of Object.entries(el)) {
    const check = ELEMENT_KEYS[k as keyof BoardElement];
    if (!check || !keyAllowed(type, k)) return false;
    if (val === null && k !== 'parent' && k !== 'control' && k !== 'crop' && k !== 'assignee' && k !== 'due') return false;
    if (!check(val)) return false;
  }
  return true;
}

/** A well-formed `set` patch for some element: known keys, valid values, null removes. */
export function isElementPatch(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  if (entries.length === 0 || entries.length > 64) return false;
  for (const [k, val] of entries) {
    if (IMMUTABLE_KEYS.has(k)) return false;
    const check = ELEMENT_KEYS[k as keyof BoardElement];
    if (!check) return false;
    if (val === null) {
      if (REQUIRED.has(k)) return false;
      continue;
    }
    if (!check(val)) return false;
  }
  return true;
}

function isTimer(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!['duration', 'endsAt', 'remaining', 'startedBy'].includes(k)) return false;
  return (
    num(0, 86_400_000)(t.duration) &&
    (t.endsAt === undefined || num(0, 1e15)(t.endsAt)) &&
    (t.remaining === undefined || num(0, 86_400_000)(t.remaining)) &&
    (t.startedBy === undefined || str(128, 1)(t.startedBy))
  );
}

function isVoting(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!['id', 'votesPerPerson', 'anonymous', 'scope', 'status', 'startedBy', 'title'].includes(k)) return false;
  }
  return (
    isId(s.id) &&
    int(1, 100)(s.votesPerPerson) &&
    bool(s.anonymous) &&
    (s.scope === undefined || (Array.isArray(s.scope) && s.scope.length <= 5000 && s.scope.every(isId))) &&
    oneOf(['open', 'closed'])(s.status) &&
    (s.startedBy === undefined || str(128, 1)(s.startedBy)) &&
    (s.title === undefined || str(200)(s.title))
  );
}

export const BOARD_KEYS: Record<keyof BoardProps, Check> = {
  background: isColor,
  grid: oneOf(['dots', 'lines', 'none']),
  timer: nullable(isTimer),
  voting: nullable(isVoting),
  locked: bool,
  privateMode: bool,
};

export function isBoardPatch(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const entries = Object.entries(v);
  if (entries.length === 0) return false;
  for (const [k, val] of entries) {
    const check = BOARD_KEYS[k as keyof BoardProps];
    if (!check) return false;
    if (val !== null && !check(val)) return false;
  }
  return true;
}

export function isBoardProps(v: unknown): v is BoardProps {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    const check = BOARD_KEYS[k as keyof BoardProps];
    if (!check) return false;
    if (val !== null && !check(val)) return false;
  }
  return true;
}
