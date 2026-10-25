/** What reading and writing a .docx file takes and gives, and how reading can fail. */

import type { DocSnapshot } from '../../model/document';

/**
 * Parts of a file WeldDocs could not bring over. The document is still read;
 * these say what is missing from it (each is listed once, for the UI to
 * translate).
 */
export type DocxImportWarning =
  | 'comments'
  /** Tracked insertions were kept and deletions dropped, without their authors. */
  | 'trackedChanges'
  /** Text boxes and drawn shapes. */
  | 'textBoxes'
  | 'charts'
  | 'smartArt'
  /** Embedded OLE objects (spreadsheets, other files). */
  | 'embeddedObjects'
  /** Word equations: their text was kept, not the layout. */
  | 'equations'
  /** Images positioned on the page: they now sit in the line of text. */
  | 'floatingImages'
  /** Endnotes became footnotes. */
  | 'endnotes'
  /** Documents pasted in as separate files (altChunk). */
  | 'embeddedDocuments'
  /** Fields other than page number, page count, date and title: their last result was kept as text. */
  | 'fields';

export interface DocxImage {
  /** What the image objects of the snapshot point to: `docx-image:<name>`. */
  src: string;
  bytes: Uint8Array;
  mime: string;
  /** File name inside the package (`image1.png`). */
  name: string;
}

export interface DocxImport {
  snapshot: DocSnapshot;
  /** The pictures the document uses, for the caller to store and re-point (`src`). */
  images: DocxImage[];
  warnings: DocxImportWarning[];
  /** The title in the file's properties, when it has one. */
  title?: string;
}

export interface ReadDocxOptions {
  /** Most bytes the package may expand to (default 512 MB, ZIP layer's budget). */
  maxBytes?: number;
  /** Ids for tables, rows, columns, footnotes, sections and images (default random). */
  makeId?: () => string;
}

export interface WriteDocxOptions {
  /** Stored as the file's title property. */
  title?: string;
  /** Bytes of an image object's `src`; images it cannot give (null) are left out. */
  images?: (src: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Creation and modification time written to the file (default now). */
  date?: Date;
}

export type DocxImportErrorCode = 'not_docx' | 'too_large' | 'corrupt' | 'unsupported';

export class DocxImportError extends Error {
  constructor(
    message: string,
    readonly code: DocxImportErrorCode,
  ) {
    super(message);
    this.name = 'DocxImportError';
  }
}
