/**
 * Sections: a section break in the body ends a section and carries that
 * section's page layout (Word's model); the last section's layout is the
 * document's. Breaking a section copies the layout of the one it splits.
 */

import { OBJECT } from '../model/chars';
import type { DocModel } from '../model/document';
import { newId } from '../model/ids';
import { BODY, type ObjectData, type SectionProps, type SectionStart } from '../model/objects';
import { NOOP, type Op } from '../ops/types';
import { insertObject, selectionRange, type DocSelection, type Edit } from './commands';

export interface SectionAt {
  props: SectionProps;
  /** Position of the section break that ends it; null for the last section. */
  breakAt: number | null;
}

/** The section a body position is in. Positions in other stories get the last section. */
export function sectionAt(doc: DocModel, story: string, pos: number): SectionAt {
  if (story === BODY) {
    const body = doc.body;
    let found: SectionAt | null = null;
    body.forEachAttr(pos, body.length, (at, attr) => {
      if (found || body.charAt(at) !== OBJECT || (attr as ObjectData).kind !== 'sectionBreak') return;
      found = { props: (attr as Extract<ObjectData, { kind: 'sectionBreak' }>).section, breakAt: at };
    });
    if (found) return found;
  }
  return { props: doc.props.section, breakAt: null };
}

/** Ends the caret's section at the caret; the next one starts on a new page or continues on this one. */
export function insertSectionBreak(doc: DocModel, sel: DocSelection, start: SectionStart, makeId: () => string = newId): Edit {
  if (sel.story !== BODY) return { op: NOOP, selection: sel };
  const current = sectionAt(doc, BODY, selectionRange(sel).from).props;
  return insertObject(doc, sel, { kind: 'sectionBreak', id: makeId(), start, section: { ...current } });
}

/** Changes the page layout of the section a position is in. */
export function setSectionAt(doc: DocModel, story: string, pos: number, patch: Partial<SectionProps>): Op {
  const at = sectionAt(doc, story, pos);
  const section = { ...at.props, ...patch };
  if (at.breakAt === null) return { type: 'setDocProps', patch: { section } };
  return { type: 'setObject', story: BODY, at: at.breakAt, patch: { section } };
}
