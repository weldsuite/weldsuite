import { batchesApi, type PaymentBatch } from '@/lib/api/domains/weldbooks-receipts';
import { batchFileName } from './pay-model';

/**
 * Fetches a batch's pain.001 file and saves it. The file holds the suppliers'
 * account numbers, so it is read on demand and never kept in the query cache.
 */
export async function downloadBatchFile(batch: Pick<PaymentBatch, 'id' | 'fileName' | 'executionDate'>): Promise<void> {
  const xml = await batchesApi.file(batch.id);
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = batchFileName(batch);
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
