import { BODY, exportPdf, toHtmlDocument, toMarkdown, toPlainText, writeDocx, type CommentText, type DocModel, type WriteSource } from '@weldsuite/docs-engine';

export type DownloadFormat = 'html' | 'markdown' | 'text' | 'docx' | 'pdf';

type TextFormat = Exclude<DownloadFormat, 'docx' | 'pdf'>;

const TYPES: Record<TextFormat, { ext: string; mime: string; write: (source: WriteSource, name: string) => string }> = {
  html: { ext: 'html', mime: 'text/html;charset=utf-8', write: toHtmlDocument },
  markdown: { ext: 'md', mime: 'text/markdown;charset=utf-8', write: (source) => toMarkdown(source) },
  text: { ext: 'txt', mime: 'text/plain;charset=utf-8', write: (source) => toPlainText(source) },
};

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type ImageSource = (src: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;

export interface ExportOptions {
  /** Picture bytes for .docx and PDF (without it they are left out). */
  images?: ImageSource;
  locale?: string;
  /** What is said in each comment thread, for .docx (without it comments are left out). */
  comments?: (thread: string) => readonly CommentText[];
}

export interface ExportedFile {
  blob: Blob;
  filename: string;
  /** Pictures that could not be fetched and are not in the file. */
  missingImages: number;
}

/** A text format: the body (with its tables and footnotes) only. */
export function exportDocument(doc: DocModel, name: string, format: TextFormat): { blob: Blob; filename: string } {
  const source: WriteSource = { content: doc.extract(BODY, 0, doc.body.length), lists: doc.lists, styles: doc.styles };
  const { ext, mime, write } = TYPES[format];
  const text = write(source, name);
  return { blob: new Blob([text], { type: mime }), filename: `${safeName(name)}.${ext}` };
}

/** Any format; .docx and PDF carry the whole document (headers, footers, sections) and its pictures. */
export async function exportFile(doc: DocModel, name: string, format: DownloadFormat, options: ExportOptions = {}): Promise<ExportedFile> {
  if (format !== 'docx' && format !== 'pdf') return { ...exportDocument(doc, name, format), missingImages: 0 };
  let missing = 0;
  const images = async (src: string) => {
    const got = src.startsWith('data:') || !options.images ? null : await options.images(src);
    if (!got && !src.startsWith('data:')) missing++;
    return got;
  };
  if (format === 'docx') {
    const bytes = await writeDocx(doc, { title: name, images: async (src) => (src.startsWith('data:') ? dataUrlBytes(src) : images(src)), comments: options.comments });
    return { blob: new Blob([bytes as BlobPart], { type: DOCX_MIME }), filename: `${safeName(name)}.docx`, missingImages: missing };
  }
  const bytes = await exportPdf(doc, { title: name, locale: options.locale, images });
  return { blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), filename: `${safeName(name)}.pdf`, missingImages: missing };
}

export async function downloadDocument(doc: DocModel, name: string, format: DownloadFormat, options: ExportOptions = {}): Promise<ExportedFile> {
  const file = await exportFile(doc, name, format, options);
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return file;
}

/** The bytes of a `data:` URL picture (the signed-out preview keeps pictures inside the document). */
function dataUrlBytes(src: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(src);
  if (!m) return null;
  const payload = m[3] ?? '';
  if (!m[2]) return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mime: m[1] ?? '' };
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime: m[1] ?? '' };
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document';
}
