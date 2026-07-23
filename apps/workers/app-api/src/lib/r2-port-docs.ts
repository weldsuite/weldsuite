/**
 * R2 storage helpers for porting-order documents (LOA, bill copy).
 *
 * Ported verbatim from apps/api-worker/src/lib/r2-port-docs.ts (W3 legacy
 * phase-out). Both workers bind the SAME bucket as `STORAGE`
 * (weldsuite-storage[-test|-preview]), so existing documents remain
 * addressable under the identical key layout:
 *
 *   port-orders/{workspaceId}/{portingOrderId}/{loa|bill}.pdf
 *
 * Validation lives here so route handlers can't accidentally skip it: every
 * upload runs through validateAndReadPdf() before R2 is touched.
 */

import type { Env } from '../types';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

export type PortDocType = 'loa' | 'bill';

export type PortDocValidationError =
  | { code: 'too_large'; sizeBytes: number; limitBytes: number }
  | { code: 'not_pdf'; detail: string }
  | { code: 'empty' };

export class PortDocError extends Error {
  readonly detail: PortDocValidationError;
  constructor(detail: PortDocValidationError) {
    super(detail.code);
    this.name = 'PortDocError';
    this.detail = detail;
  }
}

/**
 * Read the upload body, enforce size + PDF magic-byte check. We deliberately
 * do NOT trust the request Content-Type — a curl/JS caller can claim
 * application/pdf for any payload, so the magic bytes are the source of
 * truth.
 */
export async function validateAndReadPdf(file: ArrayBuffer | Uint8Array | Blob): Promise<ArrayBuffer> {
  let bytes: ArrayBuffer;
  if (file instanceof Blob) {
    bytes = await file.arrayBuffer();
  } else if (file instanceof Uint8Array) {
    // Copy to a fresh ArrayBuffer to drop any underlying SharedArrayBuffer
    bytes = file.slice().buffer as ArrayBuffer;
  } else {
    bytes = file;
  }

  if (bytes.byteLength === 0) {
    throw new PortDocError({ code: 'empty' });
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new PortDocError({
      code: 'too_large',
      sizeBytes: bytes.byteLength,
      limitBytes: MAX_BYTES,
    });
  }

  const head = new Uint8Array(bytes.slice(0, PDF_MAGIC.length));
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (head[i] !== PDF_MAGIC[i]) {
      throw new PortDocError({
        code: 'not_pdf',
        detail: 'File does not start with the PDF signature (%PDF)',
      });
    }
  }

  return bytes;
}

export function buildPortDocKey(
  workspaceId: string,
  portingOrderId: string,
  type: PortDocType,
): string {
  // Both ids come from generateId() (alphanumeric) so we don't need to
  // sanitize for path traversal — but we still strip slashes defensively.
  const safeWs = workspaceId.replace(/[^A-Za-z0-9_-]/g, '');
  const safeId = portingOrderId.replace(/[^A-Za-z0-9_-]/g, '');
  return `port-orders/${safeWs}/${safeId}/${type}.pdf`;
}

export async function uploadPortDoc(
  env: Env,
  args: {
    workspaceId: string;
    portingOrderId: string;
    type: PortDocType;
    file: ArrayBuffer | Uint8Array | Blob;
  },
): Promise<{ key: string; sizeBytes: number }> {
  const bytes = await validateAndReadPdf(args.file);
  const key = buildPortDocKey(args.workspaceId, args.portingOrderId, args.type);

  if (!env.STORAGE) {
    throw new Error('R2 STORAGE binding not configured on this worker');
  }

  await env.STORAGE.put(key, bytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: {
      portingOrderId: args.portingOrderId,
      docType: args.type,
      workspaceId: args.workspaceId,
    },
  });

  return { key, sizeBytes: bytes.byteLength };
}

export async function getPortDocBytes(env: Env, key: string): Promise<ArrayBuffer | null> {
  if (!env.STORAGE) return null;
  const obj = await env.STORAGE.get(key);
  if (!obj) return null;
  return obj.arrayBuffer();
}

export async function deletePortDocs(
  env: Env,
  workspaceId: string,
  portingOrderId: string,
): Promise<void> {
  if (!env.STORAGE) return;
  const loaKey = buildPortDocKey(workspaceId, portingOrderId, 'loa');
  const billKey = buildPortDocKey(workspaceId, portingOrderId, 'bill');
  await Promise.all([
    env.STORAGE.delete(loaKey).catch(() => undefined),
    env.STORAGE.delete(billKey).catch(() => undefined),
  ]);
}
