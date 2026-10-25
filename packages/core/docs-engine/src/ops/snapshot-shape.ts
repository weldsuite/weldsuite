/**
 * Shape check for a whole document snapshot arriving from outside (an API
 * call that creates a document from one). `DocModel.fromSnapshot` only looks
 * at `version`, so without this a snapshot could carry what the room refuses
 * in ops: a `javascript:` link, a malformed table or style. Built from the op
 * checks, so a snapshot passes exactly when the ops that would build it do.
 */

import { PARA } from '../model/chars';
import type { DocSnapshot } from '../model/document';
import { SNAPSHOT_VERSION } from '../model/document';
import { BODY, type TableData } from '../model/objects';
import { isWellFormedOp } from './shape';
import { validateStoryContent } from './validate';

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Page setup: the fields a `setDocProps` patch takes, with a section and no nulls. */
function isDocProps(props: unknown): boolean {
  if (!isPlain(props) || !isPlain(props.section)) return false;
  if (Object.values(props).includes(null)) return false;
  return isWellFormedOp({ type: 'setDocProps', patch: props });
}

/** Styles, lists and anchors: the shapes their patch ops set. */
function hasWellFormedDefinitions(s: Record<string, unknown>): boolean {
  // A patch op may leave `set` out; a snapshot always has all three.
  if (!isPlain(s.styles) || !isPlain(s.lists) || !Array.isArray(s.anchors)) return false;
  return (
    isWellFormedOp({ type: 'patchStyles', set: s.styles }) &&
    isWellFormedOp({ type: 'patchLists', set: s.lists }) &&
    isWellFormedOp({ type: 'patchAnchors', set: s.anchors }) &&
    (s.comments === undefined || (Array.isArray(s.comments) && isWellFormedOp({ type: 'patchComments', set: s.comments })))
  );
}

/** Every story is valid text that ends with a paragraph mark, and the body is there. */
function storiesAreValid(stories: DocSnapshot['stories']): boolean {
  if (!(BODY in stories)) return false;
  return Object.values(stories).every((story) => story.text.endsWith(PARA) && validateStoryContent(story) === null);
}

/** At least one row and one column, unique ids without ':', and cells only where they meet. */
function tableIsValid(table: TableData): boolean {
  if (table.rows.length === 0 || table.cols.length === 0) return false;
  const rowIds = new Set(table.rows.map((r) => r.id));
  const colIds = new Set(table.cols.map((c) => c.id));
  if (rowIds.size !== table.rows.length || colIds.size !== table.cols.length) return false;
  if ([...rowIds, ...colIds].some((id) => id.includes(':'))) return false;
  return Object.keys(table.cells ?? {}).every((key) => {
    const [r, c, rest] = key.split(':');
    return rest === undefined && r !== undefined && c !== undefined && rowIds.has(r) && colIds.has(c);
  });
}

/** True when `v` is a snapshot of the right shape all the way down, which a room would accept. */
export function isWellFormedSnapshot(v: unknown): v is DocSnapshot {
  if (!isPlain(v) || v.version !== SNAPSHOT_VERSION) return false;
  if (!isDocProps(v.props) || !hasWellFormedDefinitions(v)) return false;
  // Stories and tables have the shape of inserted content: every run, link and table checked.
  if (!isPlain(v.tables) || !isPlain(v.stories)) return false;
  const content = { text: PARA, tables: v.tables, stories: v.stories };
  if (!isWellFormedOp({ type: 'insert', story: BODY, at: 0, content })) return false;
  const snapshot = v as unknown as DocSnapshot;
  return storiesAreValid(snapshot.stories) && Object.values(snapshot.tables).every(tableIsValid);
}
