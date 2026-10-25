import { BODY, toHtmlDocument, toMarkdown, toPlainText, type DocModel, type WriteSource } from '@weldsuite/docs-engine';

export type DownloadFormat = 'html' | 'markdown' | 'text';

const TYPES: Record<DownloadFormat, { ext: string; mime: string; write: (source: WriteSource, name: string) => string }> = {
  html: { ext: 'html', mime: 'text/html;charset=utf-8', write: toHtmlDocument },
  markdown: { ext: 'md', mime: 'text/markdown;charset=utf-8', write: (source) => toMarkdown(source) },
  text: { ext: 'txt', mime: 'text/plain;charset=utf-8', write: (source) => toPlainText(source) },
};

/** The body of a document (with its tables and footnotes) as a file in `format`. */
export function exportDocument(doc: DocModel, name: string, format: DownloadFormat): { blob: Blob; filename: string } {
  const source: WriteSource = { content: doc.extract(BODY, 0, doc.body.length), lists: doc.lists, styles: doc.styles };
  const { ext, mime, write } = TYPES[format];
  const text = write(source, name);
  return { blob: new Blob([text], { type: mime }), filename: `${safeName(name)}.${ext}` };
}

export function downloadDocument(doc: DocModel, name: string, format: DownloadFormat): void {
  const { blob, filename } = exportDocument(doc, name, format);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document';
}
