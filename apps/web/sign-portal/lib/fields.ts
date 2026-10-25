import type { SignPortalEnvelope, SignPortalField } from '@weldsuite/app-api-client/schemas/weldsign';
import type { AdoptedSignature } from './signing-types';

/** Everything the signer has entered so far. */
export interface SigningState {
  /** Text and checkbox values by field id ('true' / 'false' for a checkbox). */
  values: Record<string, string>;
  signature: AdoptedSignature | null;
  initials: AdoptedSignature | null;
}

export const EMPTY_SIGNING_STATE: SigningState = { values: {}, signature: null, initials: null };

/** Fields the signer fills in themselves; name, email and date are set by the server. */
export function isInteractive(field: Pick<SignPortalField, 'type'>): boolean {
  return field.type === 'signature' || field.type === 'initials' || field.type === 'text' || field.type === 'checkbox';
}

export function isFilled(field: SignPortalField, state: SigningState): boolean {
  switch (field.type) {
    case 'signature':
      return state.signature !== null;
    case 'initials':
      return state.initials !== null;
    case 'text':
      return (state.values[field.id] ?? '').trim().length > 0;
    case 'checkbox':
      return state.values[field.id] === 'true';
    default:
      return true;
  }
}

/** Reading order across documents: document, page, then top to bottom, left to right. */
export function sortedFields(envelope: Pick<SignPortalEnvelope, 'documents' | 'fields'>): SignPortalField[] {
  const docIndex = new Map(envelope.documents.map((d, i) => [d.id, i]));
  return [...envelope.fields].sort(
    (a, b) =>
      (docIndex.get(a.documentId) ?? 0) - (docIndex.get(b.documentId) ?? 0) ||
      a.page - b.page ||
      Math.round(a.y) - Math.round(b.y) ||
      a.x - b.x,
  );
}

/** Required fields still empty, in reading order. */
export function missingRequired(ordered: SignPortalField[], state: SigningState): SignPortalField[] {
  return ordered.filter((f) => f.required && isInteractive(f) && !isFilled(f, state));
}
