/**
 * Recipient and payer copies of a filing as a PDF: fetch the layout of each
 * line from the server, draw them all in one document, save it.
 */
import { form1099Api, type Form1099Copy, type Form1099Filing, type Form1099FilingLine, type Form1099PdfCopy } from '@/lib/api/domains/weldbooks-1099';
import { downloadBlob } from '@/lib/weldbooks/download';
import { form1099PdfFilename, renderForm1099Pdf } from '@/lib/weldbooks/form-1099-pdf';

/** Layout requests that run at the same time: enough to be quick, few enough to be polite. */
const CONCURRENCY = 4;

export interface CollectedCopies {
  copies: Form1099PdfCopy[];
  warnings: string[];
  /** Lines whose copies could not be built, with the reason. */
  failed: Array<{ lineId: string; message: string }>;
}

type FetchCopies = (lineId: string, copies: readonly Form1099Copy[]) => Promise<{ copies: Form1099PdfCopy[]; warnings: string[] }>;

/**
 * The layout of the requested copies for each line, in the order of `lines`.
 * A line that fails is reported and skipped, so one recipient without a TIN
 * does not stop the rest.
 */
export async function collectCopies(
  fetchCopies: FetchCopies,
  lines: readonly Pick<Form1099FilingLine, 'id'>[],
  copies: readonly Form1099Copy[],
  onProgress?: (done: number, total: number) => void,
): Promise<CollectedCopies> {
  const results: Array<{ copies: Form1099PdfCopy[]; warnings: string[] } | { error: string }> = new Array(lines.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < lines.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fetchCopies(lines[index]!.id, copies);
      } catch (err) {
        results[index] = { error: err instanceof Error ? err.message : 'Failed' };
      }
      done += 1;
      onProgress?.(done, lines.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, lines.length) }, worker));

  const collected: CollectedCopies = { copies: [], warnings: [], failed: [] };
  const warnings = new Set<string>();
  results.forEach((result, index) => {
    if ('error' in result) {
      collected.failed.push({ lineId: lines[index]!.id, message: result.error });
      return;
    }
    collected.copies.push(...result.copies);
    for (const warning of result.warnings) warnings.add(warning);
  });
  collected.warnings = [...warnings];
  return collected;
}

export interface DownloadCopiesInput {
  filing: Pick<Form1099Filing, 'id' | 'formType' | 'taxYear'>;
  lines: readonly Form1099FilingLine[];
  copies: readonly Form1099Copy[];
  onProgress?: (done: number, total: number) => void;
}

export interface DownloadCopiesResult extends Omit<CollectedCopies, 'copies'> {
  pages: number;
  filename: string | null;
}

/** Fetches the copies, draws one PDF and saves it. Nothing is saved when no copy could be built. */
export async function downloadCopies(input: DownloadCopiesInput): Promise<DownloadCopiesResult> {
  const collected = await collectCopies(
    async (lineId, copies) => {
      const response = await form1099Api.copies(input.filing.id, lineId, copies);
      return { copies: response.data.copies, warnings: response.data.warnings };
    },
    input.lines,
    input.copies,
    input.onProgress,
  );
  if (collected.copies.length === 0) return { pages: 0, filename: null, warnings: collected.warnings, failed: collected.failed };

  const single = input.lines.length === 1 ? input.lines[0]! : null;
  const filename = form1099PdfFilename({
    form: input.filing.formType,
    taxYear: input.filing.taxYear,
    recipient: single?.recipient?.name,
    copies: input.copies,
  });
  const bytes = await renderForm1099Pdf(collected.copies);
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/pdf' }), filename);
  return { pages: collected.copies.length, filename, warnings: collected.warnings, failed: collected.failed };
}
