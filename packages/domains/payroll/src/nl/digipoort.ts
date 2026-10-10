/**
 * Logius Digipoort client for the loonaangifte: the WUS AanleverService
 * (`aanleveren`) and StatusinformatieService (`getStatussenProces`), as SOAP
 * messages with WS-Addressing and WS-Security (X.509 BinarySecurityToken,
 * XML Signature RSA-SHA256 / SHA-256 / exclusive c14n), using WebCrypto only
 * so it runs in Cloudflare Workers.
 *
 * Transport is an injected `fetch`. Digipoort also authenticates the client
 * with mutual TLS using the same PKIoverheid certificate; in production pass
 * the `fetch` of a Workers mTLS certificate binding.
 *
 * The envelope is written in exclusive-canonical form (`xmldsig.ts`), so the
 * signed parts digest identically on both ends without a parser.
 *
 * UNVERIFIED against Logius: this module could not be tested against the
 * Digipoort pre-production environment or the Aansluit Suite from here. The
 * message shapes follow the sources named in `DIGIPOORT_PROFILE`; before go-live
 * run the Aansluit Suite dialogues and the Belastingdienst test facility, and
 * check the endpoint URLs in the Logius connection documents of the new
 * Digipoort (the old Digipoort stops taking Belastingdienst traffic on
 * 1 December 2026).
 */

import { NS, base64, canonicalize, signElements, utf8, x, type XNode } from './xmldsig';

/** Protocol constants. Every value is listed in the report with its source or as unverified. */
export const DIGIPOORT_PROFILE = {
  soapNs: 'http://schemas.xmlsoap.org/soap/envelope/',
  wsaNs: 'http://www.w3.org/2005/08/addressing',
  /** Message types of the koppelvlakservices 1.2. */
  typesNs: 'http://logius.nl/digipoort/koppelvlakservices/1.2/',
  aanleverAction: 'http://logius.nl/digipoort/wus/2.0/aanleverservice/1.2/AanleverService/aanleverenRequest',
  statusAction: 'http://logius.nl/digipoort/wus/2.0/statusinformatieservice/1.2/StatusinformatieService/getStatussenProcesRequest',
  /** "Geen autorisatie adres": no asynchronous delivery of statuses. */
  noAuthorisationAddress: 'http://geenausp.nl',
  berichtsoort: 'Loonaangifte',
  /** Timestamp validity in seconds. */
  timestampTtl: 300,
} as const;

export interface DigipoortEndpoints {
  aanleveren: string;
  status: string;
}

export interface DigipoortClientOptions {
  endpoint: DigipoortEndpoints;
  fetch: (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** RSASSA-PKCS1-v1_5 / SHA-256 private key of the PKIoverheid certificate (`sign` usage). */
  signingKey: CryptoKey;
  /** The certificate itself, DER. */
  certificateDer: Uint8Array;
  /** Clock and id source; injectable so tests are deterministic. */
  now?: () => Date;
  randomId?: () => string;
}

export interface DigipoortSubmitArgs {
  /** Loonheffingennummer of the employer (identiteitBelanghebbende, type LHnr). */
  loonheffingennummer: string;
  /** Our own reference for the delivery (aanleverkenmerk), e.g. the message id. */
  aanleverkenmerk: string;
  /** The loonaangifte XML. */
  xml: string;
  fileName: string;
  /** `Bedrijf` when the employer delivers, `Intermediair` when WeldSuite delivers on its behalf. */
  role?: 'Bedrijf' | 'Intermediair';
}

export interface DigipoortStatus {
  kenmerk: string;
  statuscode: string;
  tijdstempelStatus: string;
  statusomschrijving: string;
  statusFoutcode: { foutcode: string; foutbeschrijving: string } | null;
  statusdetails: string | null;
}

export class DigipoortError extends Error {
  constructor(
    message: string,
    readonly foutcode: string | null,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;

function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Build a signed SOAP envelope; exported for tests. */
export async function buildSignedEnvelope(args: {
  action: string;
  to: string;
  body: XNode;
  signingKey: CryptoKey;
  certificateDer: Uint8Array;
  now: Date;
  messageId: string;
}): Promise<string> {
  const { soapNs, wsaNs } = DIGIPOORT_PROFILE;
  const wsuId = (id: string) => ({ ns: NS.wsu, prefix: 'wsu', name: 'Id', value: id });
  const ids = { body: 'id-body', ts: 'id-ts', to: 'id-to', action: 'id-action', msg: 'id-msgid', token: 'id-x509' };

  const action = x(wsaNs, 'wsa', 'Action', [args.action], [wsuId(ids.action)]);
  const to = x(wsaNs, 'wsa', 'To', [args.to], [wsuId(ids.to)]);
  const msgId = x(wsaNs, 'wsa', 'MessageID', [`urn:uuid:${args.messageId}`], [wsuId(ids.msg)]);
  const created = args.now;
  const expires = new Date(created.getTime() + DIGIPOORT_PROFILE.timestampTtl * 1000);
  const timestamp = x(NS.wsu, 'wsu', 'Timestamp', [x(NS.wsu, 'wsu', 'Created', [iso(created)]), x(NS.wsu, 'wsu', 'Expires', [iso(expires)])], [wsuId(ids.ts)]);
  const token = x(NS.wsse, 'wsse', 'BinarySecurityToken', [base64(args.certificateDer)], [
    { name: 'EncodingType', value: NS.base64Binary },
    { name: 'ValueType', value: NS.x509v3 },
    wsuId(ids.token),
  ]);
  const body = x(soapNs, 'soap', 'Body', [args.body], [wsuId(ids.body)]);

  const signature = await signElements({
    key: args.signingKey,
    tokenId: ids.token,
    references: [
      { id: ids.body, node: body },
      { id: ids.ts, node: timestamp },
      { id: ids.to, node: to },
      { id: ids.action, node: action },
      { id: ids.msg, node: msgId },
    ],
  });
  const security = x(NS.wsse, 'wsse', 'Security', [timestamp, token, signature], [{ ns: soapNs, prefix: 'soap', name: 'mustUnderstand', value: '1' }]);
  const envelope = x(soapNs, 'soap', 'Envelope', [x(soapNs, 'soap', 'Header', [action, to, msgId, security]), body]);
  return canonicalize(envelope);
}

/** Text of the first element with this local name (namespace-agnostic), XML-unescaped. */
function textOf(xml: string, local: string, from = 0): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`);
  const m = re.exec(xml.slice(from));
  return m ? unescape(m[1]!) : null;
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#xD;/g, '\r').replace(/&amp;/g, '&');
}

function blocks(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${local}(?:\\s[^>]*)?>[\\s\\S]*?</(?:[\\w-]+:)?${local}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[0]);
}

function faultOf(xml: string, httpStatus: number): DigipoortError | null {
  if (!/<(?:[\w-]+:)?Fault[\s>]/.test(xml)) return null;
  const foutcode = textOf(xml, 'foutcode');
  const omschrijving = textOf(xml, 'foutbeschrijving') ?? textOf(xml, 'faultstring') ?? 'SOAP fault';
  return new DigipoortError(omschrijving, foutcode, httpStatus);
}

export function createDigipoortClient(options: DigipoortClientOptions) {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? uuid;
  const { typesNs } = DIGIPOORT_PROFILE;
  const t = (name: string, children: Array<XNode | string> = []) => x(typesNs, 'ns', name, children);

  async function call(url: string, action: string, body: XNode): Promise<string> {
    const envelope = await buildSignedEnvelope({
      action,
      to: url,
      body,
      signingKey: options.signingKey,
      certificateDer: options.certificateDer,
      now: now(),
      messageId: randomId(),
    });
    const res = await options.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` },
      body: envelope,
    });
    const text = await res.text();
    const fault = faultOf(text, res.status);
    if (fault) throw fault;
    if (!res.ok) throw new DigipoortError(`Digipoort HTTP ${res.status}`, null, res.status);
    return text;
  }

  return {
    /** Deliver a loonaangifte; returns Digipoort's kenmerk for the status calls. */
    async submit(args: DigipoortSubmitArgs): Promise<{ kenmerk: string; tijdstempelAanlevering: string | null }> {
      const body = t('aanleverRequest', [
        t('berichtsoort', [DIGIPOORT_PROFILE.berichtsoort]),
        t('aanleverkenmerk', [args.aanleverkenmerk]),
        t('identiteitBelanghebbende', [t('nummer', [args.loonheffingennummer]), t('type', ['LHnr'])]),
        t('rolBelanghebbende', [args.role ?? 'Bedrijf']),
        t('berichtInhoud', [t('mimeType', ['text/xml']), t('bestandsnaam', [args.fileName]), t('inhoud', [base64(utf8(args.xml))])]),
        t('autorisatieAdres', [DIGIPOORT_PROFILE.noAuthorisationAddress]),
      ]);
      const xml = await call(options.endpoint.aanleveren, DIGIPOORT_PROFILE.aanleverAction, body);
      const kenmerk = textOf(xml, 'kenmerk');
      if (!kenmerk) throw new DigipoortError('No kenmerk in the aanleverResponse', null, 200);
      return { kenmerk, tijdstempelAanlevering: textOf(xml, 'tijdstempelAanlevering') };
    },

    /** All statuses of a delivery so far, oldest first. */
    async status(kenmerk: string): Promise<DigipoortStatus[]> {
      const body = t('getStatussenProcesRequest', [t('kenmerk', [kenmerk]), t('autorisatieAdres', [DIGIPOORT_PROFILE.noAuthorisationAddress])]);
      const xml = await call(options.endpoint.status, DIGIPOORT_PROFILE.statusAction, body);
      return blocks(xml, 'StatusResultaat').map((b) => {
        const fout = blocks(b, 'statusFoutcode')[0];
        return {
          kenmerk: textOf(b, 'kenmerk') ?? kenmerk,
          statuscode: textOf(b, 'statuscode') ?? '',
          tijdstempelStatus: textOf(b, 'tijdstempelStatus') ?? '',
          statusomschrijving: textOf(b, 'statusomschrijving') ?? '',
          statusFoutcode: fout ? { foutcode: textOf(fout, 'foutcode') ?? '', foutbeschrijving: textOf(fout, 'foutbeschrijving') ?? '' } : null,
          statusdetails: textOf(b, 'statusdetails'),
        };
      });
    },
  };
}
