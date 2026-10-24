/**
 * pdf.js, loaded on demand so it stays out of the platform's main bundle.
 * The worker ships as a separate asset (Vite `?url`).
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';

let loader: Promise<typeof import('pdfjs-dist')> | null = null;

function loadPdfjs() {
  loader ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
  );
  return loader;
}

/**
 * Open a PDF from its bytes. pdf.js transfers the buffer to its worker, which
 * detaches it, so it gets a copy and the cached bytes stay usable.
 */
export async function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
}
