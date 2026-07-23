/**
 * Object-panel stack ↔ URL serialization.
 *
 * Wire format (single `stack` query param):
 *   `<type>:<id>[:fullscreen][:tab=<tabId>]`
 *
 * Multiple panels are joined by `,`. The bottom of the stack comes first.
 * Examples:
 *   stack=customer:pty_abc:panel
 *   stack=customer:pty_abc:fullscreen,contact:cnt_xyz:panel
 *   stack=customer:pty_abc:panel:tab=contacts,contact:cnt_xyz:fullscreen
 *
 * `mode` defaults to `panel` and is omitted from the URL when not
 * fullscreen — keeps short links readable.
 */

import type { ObjectPanelHandle } from './types';

export function serializeStack(stack: ObjectPanelHandle[]): string {
  return stack
    .map((h) => {
      const parts: string[] = [`${h.type}:${h.id}`];
      if (h.mode === 'fullscreen') parts.push('fullscreen');
      if (h.initialTab) parts.push(`tab=${h.initialTab}`);
      return parts.join(':');
    })
    .join(',');
}

export function parseStack(raw: string | null | undefined): ObjectPanelHandle[] {
  if (!raw) return [];
  const out: ObjectPanelHandle[] = [];
  const entries = raw.split(',');
  for (let index = 0; index < entries.length; index++) {
    const segments = entries[index].split(':');
    const type = segments[0];
    const id = segments[1];
    if (!type || !id) continue;
    let mode: 'panel' | 'fullscreen' = 'panel';
    let initialTab: string | undefined;
    for (let i = 2; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === 'fullscreen' || seg === 'panel') mode = seg;
      else if (seg.startsWith('tab=')) initialTab = seg.slice(4);
    }
    out.push({ type, id, mode, initialTab, depth: index });
  }
  return out;
}

export function stacksEqual(
  a: ObjectPanelHandle[],
  b: ObjectPanelHandle[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.type !== y.type || x.id !== y.id || x.mode !== y.mode || x.initialTab !== y.initialTab) {
      return false;
    }
  }
  return true;
}
