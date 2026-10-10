/**
 * Envelope shape and signature. During development the same envelopes were
 * also verified with the JDK's XML Signature implementation (all references
 * and the signature value valid with exclusive c14n); here the signature is
 * checked with WebCrypto against the canonical SignedInfo.
 */
import { describe, expect, it } from 'vitest';
import { buildSignedEnvelope, createDigipoortClient, DIGIPOORT_PROFILE, DigipoortError } from './digipoort';
import { canonicalize, NS, sha256Base64, x } from './xmldsig';

async function keyPair() {
  return (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const cert = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]);

describe('exclusive c14n writer', () => {
  it('declares a namespace where it is first used, sorts attributes and escapes text', () => {
    const node = x('urn:a', 'a', 'root', [x('urn:a', 'a', 'child', ['1 < 2 & 3']), x('urn:b', 'b', 'other', [], [{ name: 'z', value: '"q"' }, { name: 'y', value: 'x' }])]);
    expect(canonicalize(node)).toBe('<a:root xmlns:a="urn:a"><a:child>1 &lt; 2 &amp; 3</a:child><b:other xmlns:b="urn:b" y="x" z="&quot;q&quot;"></b:other></a:root>');
  });
});

describe('signed SOAP envelope', () => {
  it('carries WS-Addressing headers, a timestamp, the certificate and a valid RSA-SHA256 signature', async () => {
    const { publicKey, privateKey } = await keyPair();
    const body = x(DIGIPOORT_PROFILE.typesNs, 'ns', 'aanleverRequest', [x(DIGIPOORT_PROFILE.typesNs, 'ns', 'berichtsoort', ['Loonaangifte'])]);
    const env = await buildSignedEnvelope({
      action: DIGIPOORT_PROFILE.aanleverAction,
      to: 'https://example.test/aanleveren',
      body,
      signingKey: privateKey,
      certificateDer: cert,
      now: new Date('2026-10-09T12:00:00Z'),
      messageId: '11111111-1111-4111-8111-111111111111',
    });
    expect(env.startsWith('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header><wsa:Action')).toBe(true);
    expect(env).toContain('<wsa:MessageID xmlns:wsa="http://www.w3.org/2005/08/addressing" xmlns:wsu="');
    expect(env).toContain('<wsu:Created>2026-10-09T12:00:00Z</wsu:Created><wsu:Expires>2026-10-09T12:05:00Z</wsu:Expires>');
    expect(env).toContain(`ValueType="${NS.x509v3}"`);
    expect(env).toContain('wsu:Id="id-x509">MAMCAQA=</wsse:BinarySecurityToken>');
    for (const uri of ['#id-body', '#id-ts', '#id-to', '#id-action', '#id-msgid']) expect(env).toContain(`URI="${uri}"`);

    // SignedInfo as the apex of exclusive c14n declares the ds namespace itself.
    const signedInfo = /<ds:SignedInfo>[\s\S]*<\/ds:SignedInfo>/.exec(env)![0].replace('<ds:SignedInfo>', `<ds:SignedInfo xmlns:ds="${NS.ds}">`);
    const signature = fromB64(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/.exec(env)![1]!);
    const ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, publicKey, signature, new TextEncoder().encode(signedInfo));
    expect(ok).toBe(true);

    // The body digest is the SHA-256 of the canonical body.
    const bodyNode = x('http://schemas.xmlsoap.org/soap/envelope/', 'soap', 'Body', [body], [{ ns: NS.wsu, prefix: 'wsu', name: 'Id', value: 'id-body' }]);
    const digests = [...env.matchAll(/<ds:DigestValue>([^<]+)<\/ds:DigestValue>/g)].map((m) => m[1]);
    expect(digests[0]).toBe(await sha256Base64(canonicalize(bodyNode)));
  });
});

describe('client', () => {
  it('submits a loonaangifte and reads statuses through the injected fetch', async () => {
    const { privateKey } = await keyPair();
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const responses = [
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><aanleverResponse xmlns="http://logius.nl/digipoort/koppelvlakservices/1.2/"><kenmerk>a1b2c3</kenmerk><tijdstempelAanlevering>2026-10-09T12:00:01.000+02:00</tijdstempelAanlevering></aanleverResponse></s:Body></s:Envelope>',
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><getStatussenProcesResponse xmlns="http://logius.nl/digipoort/koppelvlakservices/1.2/"><getStatussenProcesResult><StatusResultaat><kenmerk>a1b2c3</kenmerk><statuscode>100</statuscode><tijdstempelStatus>2026-10-09T12:00:01</tijdstempelStatus><statusomschrijving>Aanleveren gelukt</statusomschrijving></StatusResultaat><StatusResultaat><kenmerk>a1b2c3</kenmerk><statuscode>510</statuscode><tijdstempelStatus>2026-10-09T12:05:00</tijdstempelStatus><statusomschrijving>Validatie mislukt</statusomschrijving><statusFoutcode><foutcode>X1</foutcode><foutbeschrijving>Fout &amp; meer</foutbeschrijving></statusFoutcode></StatusResultaat></getStatussenProcesResult></getStatussenProcesResponse></s:Body></s:Envelope>',
    ];
    const client = createDigipoortClient({
      endpoint: { aanleveren: 'https://example.test/aanleveren', status: 'https://example.test/status' },
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers, body: init.body });
        const text = responses.shift()!;
        return { ok: true, status: 200, text: async () => text };
      },
      signingKey: privateKey,
      certificateDer: cert,
      now: () => new Date('2026-10-09T12:00:00Z'),
      randomId: () => '22222222-2222-4222-8222-222222222222',
    });
    const { kenmerk } = await client.submit({ loonheffingennummer: '001234560L01', aanleverkenmerk: 'msg-1', xml: '<Loonaangifte/>', fileName: 'la.xml' });
    expect(kenmerk).toBe('a1b2c3');
    expect(calls[0]!.headers.SOAPAction).toBe(`"${DIGIPOORT_PROFILE.aanleverAction}"`);
    expect(calls[0]!.body).toContain('<ns:nummer>001234560L01</ns:nummer><ns:type>LHnr</ns:type>');
    expect(calls[0]!.body).toContain(`<ns:inhoud>${btoa('<Loonaangifte/>')}</ns:inhoud>`);

    const statuses = await client.status(kenmerk);
    expect(statuses.map((s) => s.statuscode)).toEqual(['100', '510']);
    expect(statuses[1]!.statusFoutcode).toEqual({ foutcode: 'X1', foutbeschrijving: 'Fout & meer' });
  });

  it('turns a SOAP fault into a DigipoortError', async () => {
    const { privateKey } = await keyPair();
    const client = createDigipoortClient({
      endpoint: { aanleveren: 'https://example.test/a', status: 'https://example.test/s' },
      fetch: async () => ({ ok: false, status: 500, text: async () => '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>fout</faultstring><detail><aanleverFault><foutcode>ALS100</foutcode><foutbeschrijving>Ongeldig</foutbeschrijving></aanleverFault></detail></s:Fault></s:Body></s:Envelope>' }),
      signingKey: privateKey,
      certificateDer: cert,
    });
    await expect(client.submit({ loonheffingennummer: '001234560L01', aanleverkenmerk: 'k', xml: '<x/>', fileName: 'x.xml' })).rejects.toMatchObject({ foutcode: 'ALS100', message: 'Ongeldig' });
    expect(DigipoortError).toBeDefined();
  });
});
