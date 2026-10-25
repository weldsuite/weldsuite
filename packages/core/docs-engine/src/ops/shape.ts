/**
 * Shape checks for ops arriving from outside (the collaboration socket, an
 * API call). The room trusts nothing a browser sends: every field is checked
 * down to the last style key, so applying a well-formed op cannot throw on a
 * missing field or smuggle unknown keys into the document. Whether an op
 * fits the document (positions in range, ids free) is `validateOp`'s job.
 */

import { isSafeLink } from '../model/styles';

type Check = (v: unknown) => boolean;

const MAX_ID = 200;
const MAX_TEXT_OP = 2_000_000;
const MAX_LIST = 100_000;

const str =
  (max = MAX_ID, min = 1): Check =>
  (v) =>
    typeof v === 'string' && v.length >= min && v.length <= max;
const num =
  (min = -1e6, max = 1e6): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const int =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const bool: Check = (v) => typeof v === 'boolean';
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v);
const color: Check = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const arrayOf =
  (item: Check, max = MAX_LIST): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(item);
const tuple =
  (...items: Check[]): Check =>
  (v) =>
    Array.isArray(v) && v.length === items.length && items.every((c, i) => c(v[i]));
const nullable =
  (c: Check): Check =>
  (v) =>
    v === null || c(v);

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An object whose keys are all in `fields` (optional unless listed in `required`). */
function obj(fields: Record<string, Check>, required: string[] = []): Check {
  return (v) => {
    if (!isPlain(v)) return false;
    for (const k of required) if (!(k in v)) return false;
    for (const [k, val] of Object.entries(v)) {
      const check = fields[k];
      if (!check || (val !== undefined && !check(val))) return false;
    }
    return true;
  };
}

/** The patch form of an object: every field may also be null (remove it). */
function patchOf(fields: Record<string, Check>): Check {
  return obj(Object.fromEntries(Object.entries(fields).map(([k, c]) => [k, nullable(c)])));
}

function recordOf(value: Check, max = MAX_LIST, key: Check = str(MAX_ID * 3)): Check {
  return (v) => {
    if (!isPlain(v)) return false;
    const entries = Object.entries(v);
    return entries.length <= max && entries.every(([k, val]) => key(k) && value(val));
  };
}

// ---------------------------------------------------------------- formatting

const pt = num(-5000, 5000);
const positivePt = num(0, 5000);

const BORDER_LINE = obj({ width: num(0, 100), color, style: oneOf('solid', 'dashed', 'dotted', 'double') }, ['width', 'color']);

const TEXT_STYLE_FIELDS: Record<string, Check> = {
  font: str(100),
  size: num(1, 400),
  bold: bool,
  italic: bool,
  underline: bool,
  strike: bool,
  color,
  highlight: color,
  script: oneOf('super', 'sub'),
  smallCaps: bool,
  allCaps: bool,
  spacing: num(-100, 100),
  link: (v) => str(4096)(v) && isSafeLink(v as string),
  suggestion: obj({ id: str(), kind: oneOf('insert', 'delete', 'format') }, ['id', 'kind']),
};
export const isTextStyle = obj(TEXT_STYLE_FIELDS);
export const isTextStylePatch = patchOf(TEXT_STYLE_FIELDS);

const TAB_STOP = obj(
  { pos: positivePt, align: oneOf('left', 'center', 'right', 'decimal'), leader: oneOf('none', 'dot', 'hyphen', 'underscore') },
  ['pos', 'align'],
);

const PARA_FIELDS: Record<string, Check> = {
  style: str(100),
  align: oneOf('left', 'center', 'right', 'justify'),
  indentLeft: pt,
  indentRight: pt,
  indentFirst: pt,
  spaceBefore: positivePt,
  spaceAfter: positivePt,
  lineHeight: num(0.1, 10),
  lineHeightExact: num(1, 1000),
  list: obj({ id: str(), level: int(0, 8) }, ['id', 'level']),
  checked: bool,
  keepNext: bool,
  keepLines: bool,
  pageBreakBefore: bool,
  widowControl: bool,
  tabs: arrayOf(TAB_STOP, 64),
  borders: obj({ top: BORDER_LINE, bottom: BORDER_LINE, left: BORDER_LINE, right: BORDER_LINE }),
  shading: color,
  direction: oneOf('ltr', 'rtl'),
  anchorId: str(),
};
export const isParaProps = obj(PARA_FIELDS);
export const isParaPatch = patchOf(PARA_FIELDS);

const NAMED_STYLE = obj(
  {
    name: str(100),
    basedOn: str(100),
    next: str(100),
    text: isTextStyle,
    para: obj(Object.fromEntries(Object.entries(PARA_FIELDS).filter(([k]) => !['style', 'list', 'checked', 'anchorId'].includes(k)))),
    outline: int(0, 9),
  },
  ['name'],
);

const LIST_LEVEL = obj(
  {
    format: oneOf('bullet', 'check', 'decimal', 'lowerAlpha', 'upperAlpha', 'lowerRoman', 'upperRoman', 'none'),
    text: str(40, 0),
    indent: pt,
    hanging: pt,
    start: int(0, 100_000),
    style: isTextStyle,
  },
  ['format', 'text', 'indent', 'hanging'],
);
const LIST_DEF = obj({ levels: arrayOf(LIST_LEVEL, 9) }, ['levels']);

// ---------------------------------------------------------------- objects

const SECTION_FIELDS: Record<string, Check> = {
  pageWidth: num(36, 5000),
  pageHeight: num(36, 5000),
  marginTop: positivePt,
  marginBottom: positivePt,
  marginLeft: positivePt,
  marginRight: positivePt,
  headerMargin: positivePt,
  footerMargin: positivePt,
  columns: int(1, 12),
  columnGap: positivePt,
  titlePage: bool,
  evenAndOdd: bool,
  pageNumberStart: int(0, 100_000),
  pageNumberFormat: oneOf('decimal', 'lowerRoman', 'upperRoman', 'lowerAlpha', 'upperAlpha'),
  background: color,
};
const SECTION = obj(SECTION_FIELDS, [
  'pageWidth',
  'pageHeight',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'headerMargin',
  'footerMargin',
]);

const CROP = obj({ top: num(0, 1), right: num(0, 1), bottom: num(0, 1), left: num(0, 1) }, ['top', 'right', 'bottom', 'left']);

const OBJECT_FIELDS: Record<string, Record<string, Check>> = {
  image: {
    id: str(),
    src: str(4096),
    width: num(1, 5000),
    height: num(1, 5000),
    alt: str(2000, 0),
    crop: CROP,
    wrap: oneOf('inline', 'square', 'topBottom', 'behind', 'front'),
    offsetX: pt,
    offsetY: pt,
    border: BORDER_LINE,
  },
  table: { id: str() },
  pageBreak: {},
  columnBreak: {},
  sectionBreak: { id: str(), start: oneOf('nextPage', 'continuous', 'evenPage', 'oddPage'), section: SECTION },
  footnote: { id: str() },
  hr: {},
  field: { field: oneOf('page', 'pages', 'date', 'title'), format: str(100) },
  chip: { type: str(100), ref: str(), label: str(1000, 0) },
  equation: { latex: str(20_000) },
};
const OBJECT_REQUIRED: Record<string, string[]> = {
  image: ['id', 'src', 'width', 'height'],
  table: ['id'],
  sectionBreak: ['id', 'start', 'section'],
  footnote: ['id'],
  field: ['field'],
  chip: ['type', 'ref', 'label'],
  equation: ['latex'],
};

export function isObjectData(v: unknown): boolean {
  if (!isPlain(v) || typeof v.kind !== 'string' || !(v.kind in OBJECT_FIELDS)) return false;
  return obj({ kind: str(), ...OBJECT_FIELDS[v.kind] }, OBJECT_REQUIRED[v.kind] ?? [])(v);
}

/** Any patchable object field (which ones apply depends on the object's kind; `kind` and `id` never do). */
const isObjectPatch = patchOf(
  Object.fromEntries(
    Object.values(OBJECT_FIELDS)
      .flatMap((fields) => Object.entries(fields))
      .filter(([k]) => k !== 'id'),
  ),
);

// ---------------------------------------------------------------- tables

const ROW = obj({ id: str(), height: positivePt, header: bool, cantSplit: bool }, ['id']);
const COL = obj({ id: str(), width: num(1, 5000) }, ['id', 'width']);
const CELL_FIELDS: Record<string, Check> = {
  colSpan: int(1, 1000),
  rowSpan: int(1, 100_000),
  background: color,
  vAlign: oneOf('top', 'middle', 'bottom'),
  borders: obj({ top: BORDER_LINE, bottom: BORDER_LINE, left: BORDER_LINE, right: BORDER_LINE }),
  padding: positivePt,
};
const CELL = obj(CELL_FIELDS);
const TABLE_PROPS_FIELDS: Record<string, Check> = {
  align: oneOf('left', 'center', 'right'),
  indent: pt,
  border: BORDER_LINE,
  padding: positivePt,
};
const TABLE_DATA = obj(
  { rows: arrayOf(ROW, 10_000), cols: arrayOf(COL, 1000), cells: recordOf(CELL), props: obj(TABLE_PROPS_FIELDS) },
  ['rows', 'cols'],
);
const DIM = (v: unknown) => ROW(v) || COL(v);

// ---------------------------------------------------------------- content

export const isStoryContent = obj(
  {
    text: (v) => typeof v === 'string' && v.length <= MAX_TEXT_OP,
    runs: arrayOf(tuple(int(1), isTextStyle)),
    paras: arrayOf(tuple(int(0), isParaProps)),
    objects: arrayOf(tuple(int(0), isObjectData)),
  },
  ['text'],
);

export const isContent = obj(
  {
    text: (v) => typeof v === 'string' && v.length <= MAX_TEXT_OP,
    runs: arrayOf(tuple(int(1), isTextStyle)),
    paras: arrayOf(tuple(int(0), isParaProps)),
    objects: arrayOf(tuple(int(0), isObjectData)),
    tables: recordOf(TABLE_DATA),
    stories: recordOf(isStoryContent),
  },
  ['text'],
);

const OWNED = obj({ tables: recordOf(TABLE_DATA), stories: recordOf(isStoryContent) });

const ANCHOR = obj(
  { id: str(), kind: oneOf('comment', 'bookmark'), story: str(MAX_ID * 3), from: int(), to: int() },
  ['id', 'kind', 'story', 'from', 'to'],
);

const DOC_PROPS_PATCH = patchOf({ section: SECTION, pageless: bool, tabInterval: num(1, 500) });

// ---------------------------------------------------------------- ops

const storyId = str(MAX_ID * 3);
const pos = int();
const axis = oneOf('row', 'col');

const OP_CHECKS: Record<string, Check> = {
  insert: obj({ type: str(), story: storyId, at: pos, content: isContent }, ['story', 'at', 'content']),
  delete: obj({ type: str(), story: storyId, from: pos, to: pos }, ['story', 'from', 'to']),
  formatText: obj({ type: str(), story: storyId, at: pos, runs: arrayOf(tuple(int(0), nullable(isTextStylePatch))) }, ['story', 'at', 'runs']),
  formatParagraphs: obj({ type: str(), story: storyId, at: pos, runs: arrayOf(tuple(int(0), nullable(isParaPatch))) }, ['story', 'at', 'runs']),
  setObject: obj({ type: str(), story: storyId, at: pos, patch: isObjectPatch }, ['story', 'at', 'patch']),
  insertTableDims: obj(
    { type: str(), table: str(), axis, at: pos, items: arrayOf(DIM, 10_000), cells: recordOf(CELL), content: OWNED },
    ['table', 'axis', 'at', 'items'],
  ),
  deleteTableDims: obj({ type: str(), table: str(), axis, at: pos, count: int(1) }, ['table', 'axis', 'at', 'count']),
  setTableDims: obj(
    {
      type: str(),
      table: str(),
      axis,
      dims: arrayOf(tuple(str(), patchOf({ height: positivePt, header: bool, cantSplit: bool, width: num(1, 5000) })), 10_000),
    },
    ['table', 'axis', 'dims'],
  ),
  setTableCells: obj({ type: str(), table: str(), cells: arrayOf(tuple(str(MAX_ID * 2 + 1), patchOf(CELL_FIELDS))) }, ['table', 'cells']),
  setTable: obj({ type: str(), table: str(), patch: patchOf(TABLE_PROPS_FIELDS) }, ['table', 'patch']),
  createStory: obj({ type: str(), story: storyId, content: isContent }, ['story']),
  deleteStory: obj({ type: str(), story: storyId }, ['story']),
  setDocProps: obj({ type: str(), patch: DOC_PROPS_PATCH }, ['patch']),
  patchStyles: obj({ type: str(), set: recordOf(NAMED_STYLE, 500), remove: arrayOf(str(100), 500) }),
  patchLists: obj({ type: str(), set: recordOf(LIST_DEF, 5000), remove: arrayOf(str(), 5000) }),
  patchAnchors: obj({ type: str(), set: arrayOf(ANCHOR, 10_000), remove: arrayOf(str(), 10_000) }),
};

/** True when `v` is an op of the right shape all the way down (batches nested at most 4 deep). */
export function isWellFormedOp(v: unknown, depth = 0): boolean {
  if (!isPlain(v) || typeof v.type !== 'string') return false;
  if (v.type === 'batch') {
    return depth < 4 && Object.keys(v).every((k) => k === 'type' || k === 'ops') && Array.isArray(v.ops) && v.ops.length <= MAX_LIST && v.ops.every((o) => isWellFormedOp(o, depth + 1));
  }
  const check = OP_CHECKS[v.type];
  return check !== undefined && check(v);
}
