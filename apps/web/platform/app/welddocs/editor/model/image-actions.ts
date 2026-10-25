import { OBJECT, insertObject, newId, selectionRange, type ImageObject, type ObjectPatch } from '@weldsuite/docs-engine';
import type { DocController } from './doc-controller';

/** Largest size an inserted image starts at (it shrinks to fit the column). */
const MAX_START_WIDTH = 451;

export interface SelectedImage {
  story: string;
  pos: number;
  image: ImageObject;
}

/** The image the selection covers exactly (one object character), if any. */
export function selectedImage(ctl: DocController): SelectedImage | null {
  const { from, to } = selectionRange(ctl.selection);
  if (to - from !== 1) return null;
  const story = ctl.doc.stories.get(ctl.selection.story);
  if (!story || story.charAt(from) !== OBJECT) return null;
  const data = story.attrAt(from) as ImageObject | undefined;
  return data?.kind === 'image' ? { story: ctl.selection.story, pos: from, image: data } : null;
}

/** Natural size of an image at a URL, in CSS pixels (null when it cannot be loaded). */
export function imageSize(src: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Inserts an image at the caret, sized from its pixels (1 px = ¾ pt) and fitted to the column. */
export async function insertImage(ctl: DocController, src: string, alt?: string): Promise<boolean> {
  if (ctl.readOnly) return false;
  const size = await imageSize(src);
  if (!size) return false;
  const s = ctl.section;
  const column = Math.min(MAX_START_WIDTH, s.pageWidth - s.marginLeft - s.marginRight);
  let width = size.width * 0.75;
  let height = size.height * 0.75;
  if (width > column) {
    height *= column / width;
    width = column;
  }
  const image: ImageObject = { kind: 'image', id: newId(), src, width: round(width), height: round(height) };
  if (alt) image.alt = alt;
  ctl.apply(insertObject(ctl.doc, ctl.selection, image));
  return true;
}

export function patchImage(ctl: DocController, target: SelectedImage, patch: ObjectPatch): void {
  ctl.apply({ op: { type: 'setObject', story: target.story, at: target.pos, patch }, selection: { story: target.story, anchor: target.pos, head: target.pos + 1 } });
}

/** Resizes to a width, keeping the image's proportions. */
export function resizeImage(ctl: DocController, target: SelectedImage, width: number): void {
  const w = Math.max(8, Math.min(2000, width));
  const ratio = target.image.height / target.image.width;
  patchImage(ctl, target, { width: round(w), height: round(w * ratio) });
}

export function deleteImage(ctl: DocController, target: SelectedImage): void {
  ctl.apply({ op: { type: 'delete', story: target.story, from: target.pos, to: target.pos + 1 }, selection: { story: target.story, anchor: target.pos, head: target.pos } });
}

/** Reads a picked file as a data URL (the signed-out preview keeps images inside the document). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
