/**
 * Digipoort adapter: sending the Dutch loonaangifte to the Belastingdienst.
 *
 * Optional by design. The gateway exists only when the worker has the
 * PKIoverheid certificate binding and the connection settings, and the
 * workspace has the `weldhr-payroll-digipoort` flag on; otherwise the submit
 * endpoint answers `DIGIPOORT_NOT_CONFIGURED` and the employer files the
 * downloaded XML itself ("mark as filed").
 *
 * The protocol client is @weldsuite/payroll-domain's `createDigipoortClient`
 * (nl/digipoort.ts). Its own header says it is UNVERIFIED against Logius: run
 * the Aansluit Suite dialogues and the Belastingdienst test facility, and
 * check the service URLs, before turning the flag on for anyone. The status
 * mapping below is conservative for the same reason: only an explicit
 * "verwerkt" with no error is treated as accepted.
 */

import { DigipoortError, createDigipoortClient, type DigipoortStatus } from '@weldsuite/payroll-domain/nl/digipoort';
import type { DigipoortGateway } from './deps';

export interface DigipoortEnv {
  /** Cloudflare mTLS certificate binding holding the PKIoverheid client certificate. */
  DIGIPOORT_CERT?: Fetcher;
  /** URL of the WUS AanleverService (aanleveren) of the Digipoort environment. */
  DIGIPOORT_AANLEVER_URL?: string;
  /** URL of the StatusinformatieService (getStatussenProces). */
  DIGIPOORT_STATUS_URL?: string;
  /** PKCS#8 PEM of the key that signs messages (RSA). */
  DIGIPOORT_SIGNING_KEY?: string;
  /** Base64 DER of the signing certificate. */
  DIGIPOORT_CERTIFICATE_DER?: string;
}

export interface DigipoortSettings {
  aanleverUrl: string;
  statusUrl: string;
  fetch: (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  signingKeyPem: string;
  certificateDerBase64: string;
}

/** The settings, or null when anything is missing. */
export function digipoortSettings(env: DigipoortEnv): DigipoortSettings | null {
  if (!env.DIGIPOORT_CERT || !env.DIGIPOORT_AANLEVER_URL || !env.DIGIPOORT_STATUS_URL || !env.DIGIPOORT_SIGNING_KEY || !env.DIGIPOORT_CERTIFICATE_DER) return null;
  const binding = env.DIGIPOORT_CERT;
  return {
    aanleverUrl: env.DIGIPOORT_AANLEVER_URL,
    statusUrl: env.DIGIPOORT_STATUS_URL,
    fetch: (input, init) => binding.fetch(input, init),
    signingKeyPem: env.DIGIPOORT_SIGNING_KEY,
    certificateDerBase64: env.DIGIPOORT_CERTIFICATE_DER,
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** An RSA PKCS#8 PEM as a WebCrypto signing key. */
export async function importSigningKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN [A-Z ]+-----/, '').replace(/-----END [A-Z ]+-----/, '');
  return crypto.subtle.importKey('pkcs8', base64ToBytes(body), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * What Digipoort said last, as a filing status. A fault code is a rejection;
 * only an explicit "verwerkt" / "accepted" without one is acceptance; anything
 * else is still on its way.
 */
export function filingStatusFrom(statuses: DigipoortStatus[]): { status: 'submitted' | 'accepted' | 'rejected'; message: string | null } {
  const failed = [...statuses].reverse().find((s) => s.statusFoutcode);
  if (failed?.statusFoutcode) {
    return { status: 'rejected', message: `${failed.statusFoutcode.foutcode} ${failed.statusFoutcode.foutbeschrijving}`.trim() };
  }
  const last = statuses.at(-1);
  if (!last) return { status: 'submitted', message: null };
  if (/verwerkt|geaccepteerd|accepted/i.test(last.statusomschrijving)) return { status: 'accepted', message: last.statusomschrijving };
  return { status: 'submitted', message: last.statusomschrijving || null };
}

/** The gateway over the real client, building the client (and importing the key) on first use. */
export function connectDigipoort(settings: DigipoortSettings, now?: () => Date): DigipoortGateway {
  let client: Promise<ReturnType<typeof createDigipoortClient>> | null = null;
  const get = () =>
    (client ??= (async () =>
      createDigipoortClient({
        endpoint: { aanleveren: settings.aanleverUrl, status: settings.statusUrl },
        fetch: settings.fetch,
        signingKey: await importSigningKey(settings.signingKeyPem),
        certificateDer: base64ToBytes(settings.certificateDerBase64),
        now,
      }))());
  return {
    async submit(input) {
      try {
        const result = await (await get()).submit({
          loonheffingennummer: input.loonheffingennummer,
          aanleverkenmerk: input.messageId,
          xml: input.xml,
          fileName: input.fileName,
        });
        return { reference: result.kenmerk };
      } catch (err) {
        throw err instanceof DigipoortError ? new Error(`${err.foutcode ? `${err.foutcode}: ` : ''}${err.message}`) : err;
      }
    },
    async status(reference) {
      try {
        return filingStatusFrom(await (await get()).status(reference));
      } catch (err) {
        throw err instanceof DigipoortError ? new Error(`${err.foutcode ? `${err.foutcode}: ` : ''}${err.message}`) : err;
      }
    },
  };
}

/** The gateway for a worker: null unless configured. */
export function createDigipoortGateway(env: DigipoortEnv, connect: (settings: DigipoortSettings) => DigipoortGateway = connectDigipoort): DigipoortGateway | null {
  const settings = digipoortSettings(env);
  return settings ? connect(settings) : null;
}
