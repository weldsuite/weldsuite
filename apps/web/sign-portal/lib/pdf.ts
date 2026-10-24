/**
 * pdf.js, loaded on demand so it stays out of the first paint. The legacy
 * build is used on purpose: signers open links on whatever phone they own, and
 * the modern build needs very recent browser APIs (Promise.withResolvers).
 * The worker ships as a separate asset.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist';

type PdfjsModule = typeof import('pdfjs-dist');

let loader: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  loader ??= import('pdfjs-dist/legacy/build/pdf.mjs')
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).toString();
      return pdfjs;
    })
    .catch((error: unknown) => {
      // Let a later attempt retry instead of caching the failure.
      loader = null;
      throw error;
    });
  return loader;
}

/**
 * Open a PDF from its bytes. pdf.js transfers the buffer to its worker, which
 * detaches it, so it gets a copy and the caller's bytes stay usable.
 */
export async function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise;
}
