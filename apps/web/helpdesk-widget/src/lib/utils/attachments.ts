/** File types the widget API accepts for chat attachments (mirrors helpdesk-widget-api routes/attachments.ts). */
export const ALLOWED_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

/** Value for `<input type="file" accept>`. */
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_TYPES.join(',');

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 10;

/** Why a file can't be attached, or null when it can. Worded for the visitor. */
export function attachmentProblem(file: File): string | null {
  if (!(ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return 'This file type is not supported';
  if (file.size > MAX_ATTACHMENT_BYTES) return 'File is too large (max 10 MB)';
  return null;
}

export function isImageAttachment(contentType: string): boolean {
  return contentType.startsWith('image/');
}

/** Only http(s) links are rendered; anything else (javascript:, data:) is dropped. */
export function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
