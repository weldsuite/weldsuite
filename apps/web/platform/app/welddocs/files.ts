/**
 * Files in and out, in the browser: a .docx, Markdown, HTML or text file read
 * into a new document, and a document written as .docx or PDF. Both work the
 * same in a workspace and in the signed-out preview; only where an imported
 * file's pictures go differs (WeldDrive storage, or inside the document).
 */

import { DocxImportError, readDocx, type DocSnapshot, type DocxCommentThread, type DocxImportErrorCode, type DocxImportWarning, type ImageObject } from '@weldsuite/docs-engine';
import { getAppApiUrl } from '@/lib/api/public-env';
import { documentFromText } from './store/doc-store';

/** Files that can become a document. */
export const IMPORT_ACCEPT = '.docx,.md,.markdown,.txt,.html,.htm,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain,text/html';
/** Largest file read in the browser. */
export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;
/** How far a .docx may expand when unzipped. */
const DOCX_MAX_EXPANDED = 256 * 1024 * 1024;

const IMPORTABLE = /\.(docx|md|markdown|txt|html?)$/i;

export function canImportName(name: string): boolean {
  return IMPORTABLE.test(name);
}

export interface ImportedDocument {
  name: string;
  snapshot: DocSnapshot;
  /** What the file had that the document does not (for the "left out" note). */
  warnings: DocxImportWarning[];
  /** What is said in the comment threads of the snapshot, for the document's chat. */
  comments: DocxCommentThread[];
}

/** Stores a picture of an imported file; its address, or null to keep the picture inside the document. */
export type StoreImage = (image: { name: string; bytes: Uint8Array; mime: string }) => Promise<string | null>;

/** Why an import failed, for the message (null for anything unexpected). */
export function importFailure(err: unknown): DocxImportErrorCode | null {
  return err instanceof DocxImportError ? err.code : null;
}

/** Reads a file into a new document. A .docx file's pictures go through `storeImage` first. */
export async function readImport(fileName: string, bytes: Uint8Array, storeImage?: StoreImage): Promise<ImportedDocument> {
  const name = fileName.replace(/\.[^.]+$/, '').trim() || fileName;
  if (bytes.byteLength > IMPORT_MAX_BYTES) throw new DocxImportError('The file is too large to open', 'too_large');
  if (!/\.docx$/i.test(fileName)) {
    if (!canImportName(fileName)) throw new DocxImportError('This kind of file cannot be opened', 'unsupported');
    return { name, snapshot: documentFromText(fileName, new TextDecoder().decode(bytes)), warnings: [], comments: [] };
  }
  const read = await readDocx(bytes, { maxBytes: DOCX_MAX_EXPANDED });
  const srcs = new Map<string, string>();
  for (const image of read.images) {
    const stored = storeImage ? await storeImage(image).catch(() => null) : null;
    srcs.set(image.src, stored ?? dataUrl(image.bytes, image.mime));
  }
  repointImages(read.snapshot, srcs);
  return { name, snapshot: read.snapshot, warnings: read.warnings, comments: read.comments };
}

/** Points every image object at its stored picture. */
function repointImages(snapshot: DocSnapshot, srcs: Map<string, string>): void {
  for (const story of Object.values(snapshot.stories)) {
    for (const [, obj] of story.objects ?? []) {
      if (obj.kind !== 'image') continue;
      const src = srcs.get(obj.src);
      if (src) (obj as ImageObject).src = src;
    }
  }
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

const PRIVATE_PATH = '/api/storage/private/';

/**
 * Fetches a picture's bytes for an export. Private WeldDrive files on
 * app-api (`apiOrigin`) take the member's session token (an `<img>` uses the
 * files cookie instead); the token never goes to any other host, whatever
 * its path. Other addresses are fetched as they are, and give nothing when
 * the site does not allow it.
 */
export function imageFetcher(getToken: () => Promise<string | null>, apiOrigin: string = getAppApiUrl()) {
  return async (src: string): Promise<{ bytes: Uint8Array; mime: string } | null> => {
    try {
      const headers: Record<string, string> = {};
      if (isPrivateFile(src, apiOrigin)) {
        const token = await getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      const res = await fetch(src, { headers });
      if (!res.ok) return null;
      const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime };
    } catch {
      return null;
    }
  };
}

/** A private WeldDrive address on app-api itself: same origin and the private path. */
function isPrivateFile(src: string, apiOrigin: string): boolean {
  try {
    const url = new URL(src, window.location.href);
    return url.origin === new URL(apiOrigin).origin && url.pathname.startsWith(PRIVATE_PATH);
  } catch {
    return false;
  }
}

/** Bytes of a file someone may read: the private WeldDrive address with the session token, or the address as it is. */
export async function fileBytes(url: string, getToken: () => Promise<string | null>): Promise<Uint8Array | null> {
  const got = await imageFetcher(getToken)(url);
  return got?.bytes ?? null;
}
