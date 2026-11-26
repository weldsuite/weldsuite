import type {
  SignPortalCompleteInput,
  SignPortalEnvelope,
  SignPortalSignatureStart,
} from '@weldsuite/app-api-client/schemas/weldsign';
import type { Dictionary } from './i18n';
import { PortalApiError, PortalNetworkError, portalJson } from './portal-client';

/** An advanced or qualified level, or undefined for a simple signer. */
export type SignatureLevel = SignPortalEnvelope['signatureLevel'];

/** Why the signer is back from their provider without having signed (`?signature=`). */
export type SignatureReturn = 'failed' | 'cancelled';

/** What a failed Finish tells the signer. */
export function finishErrorMessage(err: unknown, level: SignatureLevel, t: Dictionary): string {
  if (err instanceof PortalNetworkError) return t.error.network;
  if (!(err instanceof PortalApiError)) return t.sign.finishFailed;
  if (err.status === 401) return t.sign.sessionExpired;
  // Signed, but the request could not be finished yet: finishing again picks it up.
  if (err.status === 503) return level ? t.eidas.unavailable : t.sign.finishPending;
  return t.sign.finishFailed;
}

/** The Finish button's label. */
export function finishLabel(finishing: boolean, level: SignatureLevel, provider: string | null, t: Dictionary): string {
  if (level) return finishing ? t.eidas.finishing : t.eidas.finish(provider);
  return finishing ? t.sign.finishing : t.sign.finish;
}

/** Only a web address is followed to the provider. */
export function isProviderUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * Send an advanced or qualified signer to their trust service provider: the
 * backend keeps the submission and answers where to go. The provider has the
 * signer from here; the callback page brings them back to their link.
 */
export async function startProviderSignature(
  withSession: <T>(run: () => Promise<T>) => Promise<T>,
  body: SignPortalCompleteInput,
  go: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const start = await withSession(() =>
    portalJson<Pick<SignPortalSignatureStart, 'redirectUrl'>>('/api/portal/signature/start', body),
  );
  if (!isProviderUrl(start.redirectUrl)) throw new Error('Unexpected redirect');
  go(start.redirectUrl);
}

/** A request with advanced or qualified signers has an evidence report. */
export function hasEvidenceReport(envelope: SignPortalEnvelope): boolean {
  return envelope.hasEvidence ?? envelope.signatureLevel !== undefined;
}

/** The download name for a request's PDF (`suffix` for the evidence report). */
export function pdfFileName(title: string, suffix = ''): string {
  return `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document'}${suffix}.pdf`;
}

/** The `?signature=` the callback page sent the signer back with, if any. */
export function readSignatureReturn(search: string): SignatureReturn | null {
  const value = new URLSearchParams(search).get('signature');
  return value === 'failed' || value === 'cancelled' ? value : null;
}
