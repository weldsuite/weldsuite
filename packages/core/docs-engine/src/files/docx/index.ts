/** WordprocessingML (.docx) in and out, on the shared ZIP and XML layer. */

export { readDocx } from './read';
export { writeDocx } from './write';
export { DocxImportError } from './types';
export type { DocxImage, DocxImport, DocxImportErrorCode, DocxImportWarning, ReadDocxOptions, WriteDocxOptions } from './types';
