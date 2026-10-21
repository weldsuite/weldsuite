/**
 * The type to file an accounting-inbox attachment under, or null when OCR
 * cannot read it. Only PDFs and images are kept. Many mail clients send a PDF
 * as `application/octet-stream`, so a `.pdf` name counts too.
 */
export function accountingAttachmentType(att: { contentType: string; fileName: string }): string | null {
  const [base = ''] = (att.contentType || 'application/octet-stream').split(';');
  const mimeType = base.trim().toLowerCase();
  if (mimeType === 'application/pdf' || mimeType.startsWith('image/')) return mimeType;
  if (mimeType === 'application/octet-stream' && att.fileName.toLowerCase().endsWith('.pdf')) {
    return 'application/pdf';
  }
  return null;
}
