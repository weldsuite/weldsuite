/**
 * The PDF writer: `exportPdf` plus the pieces it is built from that are
 * useful on their own (TrueType parsing and subsetting, image decoding).
 */

export { exportPdf } from './export-pdf';
export type { PdfExportOptions } from './export-pdf';
export { parseTrueType, glyphComponents } from './truetype';
export type { TrueTypeFont } from './truetype';
export { FontSubset, assembleFont } from './subset';
export { decodePng } from './png';
export type { DecodedImage } from './png';
export { parseJpeg, readImage } from './images';
export type { JpegInfo, PdfImage } from './images';

// Building blocks for other PDF writers (WeldBoard's board export).
export { writeImage } from './export-pdf';
export { PdfWriter, literal, name, num, pdfDate, ref, textString } from './pdf-writer';
export { ContentStream, parseColor } from './content';
export type { Rgb } from './content';
export { latin1 } from './bytes';
export { dataUrlBytes } from './images';
export { FIRST_CHAR, LAST_CHAR, roundWidth, standardFont, standardWidths, winAnsiCode } from './standard-fonts';
export type { StandardFontName } from './standard-fonts';
