/**
 * The icon of an email attachment, by what kind of file it is: the extension
 * first, the MIME type when the name has none we know. PDFs and anything
 * unknown get the plain file icon.
 */
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

const ICON_BY_EXTENSION: Record<string, LucideIcon> = {
  pdf: File,
  doc: FileText, docx: FileText, odt: FileText, rtf: FileText, txt: FileText, md: FileText, pages: FileText,
  xls: FileSpreadsheet, xlsx: FileSpreadsheet, ods: FileSpreadsheet, csv: FileSpreadsheet, numbers: FileSpreadsheet,
  ppt: Presentation, pptx: Presentation, odp: Presentation, key: Presentation,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, webp: FileImage, svg: FileImage, heic: FileImage, bmp: FileImage, tif: FileImage, tiff: FileImage,
  mp4: FileVideoCamera, mov: FileVideoCamera, avi: FileVideoCamera, webm: FileVideoCamera, mkv: FileVideoCamera, m4v: FileVideoCamera,
  mp3: FileMusic, wav: FileMusic, m4a: FileMusic, ogg: FileMusic, flac: FileMusic, aac: FileMusic,
  zip: FileArchive, rar: FileArchive, '7z': FileArchive, gz: FileArchive, tar: FileArchive, tgz: FileArchive,
  json: FileCode, xml: FileCode, html: FileCode, htm: FileCode, css: FileCode, js: FileCode, ts: FileCode, sql: FileCode, yaml: FileCode, yml: FileCode,
};

const ICON_BY_MIME_PREFIX: Array<[prefix: string, icon: LucideIcon]> = [
  ['image/', FileImage],
  ['video/', FileVideoCamera],
  ['audio/', FileMusic],
  ['text/', FileText],
];

export function attachmentIcon(fileName: string, contentType?: string | null): LucideIcon {
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const byExtension = ICON_BY_EXTENSION[extension];
  if (byExtension) return byExtension;
  const mime = contentType?.toLowerCase() ?? '';
  return ICON_BY_MIME_PREFIX.find(([prefix]) => mime.startsWith(prefix))?.[1] ?? File;
}
