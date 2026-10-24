/**
 * Receipt photos for expense declarations.
 *
 * hr-api takes one image or PDF per declaration as multipart `file`
 * (`HR_DECLARATION_RECEIPT_TYPES`, at most 10 MB). On a phone the file is a
 * local `file://` URI, which React Native's FormData sends when given
 * `{ uri, name, type }`; in the browser preview it is a `blob:` URL that has
 * to be read into a real Blob first.
 */

import { Platform } from 'react-native';

import { appApiClient } from '@/services/app-api';

// Same limits as HR_DECLARATION_RECEIPT_* in @weldsuite/app-api-client/schemas/weldhr.
// Copied rather than imported: that module loads zod at runtime, which this
// bundle does not otherwise ship.
const HR_DECLARATION_RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const HR_DECLARATION_RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export interface LocalReceipt {
  uri: string;
  name: string;
  /** MIME type. */
  type: string;
  /** Bytes, when the picker reports it. */
  size?: number | null;
}

/** What the picker hands back, reduced to the fields we read. */
export interface PickedAsset {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
}

export type ReceiptProblem = 'type' | 'size';

/** Turn a picked photo into a receipt, or say why it cannot be one. */
export function toReceipt(asset: PickedAsset, now: Date = new Date()): LocalReceipt | ReceiptProblem {
  const type = (asset.mimeType || guessType(asset.fileName || asset.uri) || '').toLowerCase();
  if (!HR_DECLARATION_RECEIPT_TYPES.includes(type)) return 'type';
  if (asset.fileSize && asset.fileSize > HR_DECLARATION_RECEIPT_MAX_BYTES) return 'size';
  const extension = type === 'application/pdf' ? 'pdf' : type.split('/')[1].replace('jpeg', 'jpg');
  const stamp = now.toISOString().slice(0, 10);
  return {
    uri: asset.uri,
    name: asset.fileName?.trim() || `receipt-${stamp}.${extension}`,
    type,
    size: asset.fileSize ?? null,
  };
}

function guessType(name: string): string | null {
  const match = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(name);
  switch (match?.[1]?.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    default:
      return null;
  }
}

async function receiptForm(receipt: LocalReceipt): Promise<FormData> {
  const form = new FormData();
  if (Platform.OS === 'web') {
    const blob = await (await fetch(receipt.uri)).blob();
    form.append('file', new File([blob], receipt.name, { type: receipt.type }));
  } else {
    // React Native's FormData streams the file from disk when given this shape.
    form.append('file', { uri: receipt.uri, name: receipt.name, type: receipt.type } as unknown as Blob);
  }
  return form;
}

/** Attach the receipt to the caller's own declaration. Throws on failure. */
export async function uploadReceipt(declarationId: string, receipt: LocalReceipt): Promise<void> {
  await appApiClient.postForm(
    `/weldhr/me/declarations/${encodeURIComponent(declarationId)}/receipt`,
    await receiptForm(receipt),
  );
}
