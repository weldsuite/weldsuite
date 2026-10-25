import {
  ContentBuilder,
  PARA,
  cleanStoryText,
  fromHtml,
  isWellFormedOp,
  toHtml,
  toPlainText,
  type Content,
  type DocModel,
  type Fragment,
  type ListDef,
  type ParaProps,
} from '@weldsuite/docs-engine';

/** What a copy puts on the clipboard. */
export interface ClipboardPayload {
  html: string;
  text: string;
  /** The exact fragment, for pasting back into WeldDocs without loss. */
  json: string;
}

/** Custom clipboard type browsers keep between WeldDocs tabs. */
export const FRAGMENT_TYPE = 'web application/x-welddocs+json';
const MARKER = /<!--welddocs:([A-Za-z0-9+/=]+)-->/;

/** [from, to) of a story as clipboard data: HTML and text for other apps, the fragment itself for WeldDocs. */
export function copyFragment(doc: DocModel, story: string, from: number, to: number): ClipboardPayload {
  const content = doc.extract(story, from, to);
  const lists: Record<string, ListDef> = {};
  for (const [, props] of content.paras ?? []) addList(doc, props, lists);
  for (const s of Object.values(content.stories ?? {})) for (const [, props] of s.paras ?? []) addList(doc, props, lists);
  const fragment: Fragment = Object.keys(lists).length ? { content, lists } : { content };
  const json = JSON.stringify(fragment);
  const html = toHtml({ content, lists, styles: doc.styles });
  return {
    // The fragment rides along in a comment too, for browsers that drop custom types.
    html: `<!--welddocs:${toBase64(json)}-->${html}`,
    text: toPlainText({ content, lists }),
    json,
  };
}

function addList(doc: DocModel, props: ParaProps, lists: Record<string, ListDef>): void {
  if (!props.list || lists[props.list.id]) return;
  const def = doc.lists.get(props.list.id);
  if (def) lists[props.list.id] = def;
}

/** A fragment from clipboard data: ours if it is there, else HTML, else text (`plain` pastes text only). */
export function readClipboard(data: { html?: string; text?: string; json?: string }, plain: boolean): Fragment | null {
  if (!plain) {
    const json = data.json || (data.html ? fromMarker(data.html) : null);
    const ours = json ? parseFragment(json) : null;
    if (ours) return ours;
    if (data.html) return fromHtml(data.html);
  }
  if (data.text) return textFragment(data.text);
  return null;
}

function fromMarker(html: string): string | null {
  const m = MARKER.exec(html);
  return m ? fromBase64(m[1]!) : null;
}

/** Our own fragment JSON, shape-checked like an op from outside. */
function parseFragment(json: string): Fragment | null {
  try {
    const parsed = JSON.parse(json) as { content?: Content; lists?: Record<string, ListDef> };
    if (!parsed.content || !isWellFormedOp({ type: 'insert', story: 'body', at: 0, content: parsed.content })) return null;
    if (parsed.lists && !isWellFormedOp({ type: 'patchLists', set: parsed.lists })) return null;
    return parsed.lists ? { content: parsed.content, lists: parsed.lists } : { content: parsed.content };
  } catch {
    return null;
  }
}

/** Plain text: each line a paragraph (the last one without its mark, so it joins the text pasted into). */
export function textFragment(text: string): Fragment {
  const lines = cleanStoryText(text.replace(/\r\n?/g, '\n')).split(PARA);
  const b = new ContentBuilder();
  lines.forEach((line, i) => {
    b.addText(line);
    if (i < lines.length - 1) b.endParagraph();
  });
  return { content: b.build() };
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
