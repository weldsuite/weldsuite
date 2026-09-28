/**
 * Digipoort API Client
 *
 * Handles submission of BTW-aangifte (and other SBR filings) to the Dutch
 * Belastingdienst via Digipoort:
 * - aanleverservice (submission)
 * - statusinformatieservice (status polling)
 *
 * Authentication is a PKIoverheid services server certificate presented via
 * mTLS. Cloudflare Workers cannot attach client certificates to plain fetch(),
 * so transmission goes through the `DIGIPOORT_CERT` mTLS certificate binding
 * (wrangler.toml `mtls_certificates`, uploaded with
 * `wrangler mtls-certificate upload`). The binding's fetcher presents the
 * certificate on every request to the bound hostnames.
 *
 * Modes (DIGIPOORT_MODE env var):
 * - 'simulated' (default) — envelopes are built but nothing is transmitted;
 *   safe until the PKIoverheid certificate is provisioned.
 * - 'preprod' — real transmission to the Digipoort preprod environment.
 * - 'production' — real transmission to production.
 */

// ============================================================================
// Types
// ============================================================================

export type DigipoortMode = 'simulated' | 'preprod' | 'production';

/** Subset of the worker Env this service needs. */
export interface DigipoortEnv {
  DIGIPOORT_MODE?: string;
  /** mTLS certificate binding (Cloudflare `mtls_certificates`). */
  DIGIPOORT_CERT?: { fetch: typeof fetch };
}

export interface DigipoortConfig {
  /** Digipoort aanleverservice SOAP endpoint URL */
  aanleverServiceUrl: string;
  /** Digipoort statusservice SOAP endpoint URL */
  statusServiceUrl: string;
  /** BTW number of the filing entity */
  btwNumber: string;
  mode: DigipoortMode;
  /** mTLS fetcher from the certificate binding (required for non-simulated modes). */
  fetcher?: { fetch: typeof fetch };
}

export interface DigipoortSubmitResult {
  success: boolean;
  /** Filing reference (kenmerk) returned by / sent to Digipoort */
  kenmerk?: string;
  /** Timestamp of submission */
  timestamp?: string;
  /** Whether this was a simulated (non-transmitted) submission */
  simulated?: boolean;
  /** Error message if submission failed */
  error?: string;
  /** Raw SOAP response for debugging */
  rawResponse?: string;
}

export interface DigipoortStatusResult {
  success: boolean;
  /** Current processing status */
  status: 'submitted' | 'processing' | 'accepted' | 'rejected' | 'unknown';
  /** Human-readable status description */
  statusDescription?: string;
  /** Timestamp of status check */
  timestamp?: string;
  simulated?: boolean;
  /** Error message if status check failed */
  error?: string;
}

// ============================================================================
// Endpoints
// ============================================================================

/** Digipoort test environment (preprod) endpoints */
export const DIGIPOORT_TEST_ENDPOINTS = {
  aanleverServiceUrl:
    'https://preprod-dgp2.procesinfrastructuur.nl/wus/2.0/aanleverservice/1.2',
  statusServiceUrl:
    'https://preprod-dgp2.procesinfrastructuur.nl/wus/2.0/statusinformatieservice/1.2',
} as const;

/** Digipoort production endpoints */
export const DIGIPOORT_PRODUCTION_ENDPOINTS = {
  aanleverServiceUrl:
    'https://dgp2.procesinfrastructuur.nl/wus/2.0/aanleverservice/1.2',
  statusServiceUrl:
    'https://dgp2.procesinfrastructuur.nl/wus/2.0/statusinformatieservice/1.2',
} as const;

// ============================================================================
// SOAP Envelope Builders
// ============================================================================

function buildAanleverSoapEnvelope(
  btwNumber: string,
  xmlContent: string,
  berichtKenmerk: string,
  berichtsoort = 'Omzetbelasting',
): string {
  // Base64-encode the XBRL content for the SOAP attachment
  const base64Content = btoa(unescape(encodeURIComponent(xmlContent)));

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:aanl="http://logius.nl/digipoort/wus/2.0/aanleverservice/1.2"
  xmlns:iden="http://logius.nl/digipoort/koppelvlakstandaard/1.2/MSIdentificatie">
  <soapenv:Header/>
  <soapenv:Body>
    <aanl:aanleverRequest>
      <aanl:berichtsoort>${escapeXml(berichtsoort)}</aanl:berichtsoort>
      <aanl:aanleverkenmerk>${escapeXml(berichtKenmerk)}</aanl:aanleverkenmerk>
      <aanl:rolBelanghebbende>Belanghebbende</aanl:rolBelanghebbende>
      <aanl:identiteitBelanghebbende>
        <iden:nummer>${escapeXml(btwNumber)}</iden:nummer>
        <iden:type>BTW</iden:type>
      </aanl:identiteitBelanghebbende>
      <aanl:identiteitIntermediair>
        <iden:nummer>${escapeXml(btwNumber)}</iden:nummer>
        <iden:type>BTW</iden:type>
      </aanl:identiteitIntermediair>
      <aanl:autorisatieAdres>http://geenausp.nl</aanl:autorisatieAdres>
      <aanl:berichtInhoud>
        <aanl:mimeType>application/xml</aanl:mimeType>
        <aanl:bestandsnaam>btw-aangifte.xbrl</aanl:bestandsnaam>
        <aanl:inhoud>${base64Content}</aanl:inhoud>
      </aanl:berichtInhoud>
    </aanl:aanleverRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildStatusSoapEnvelope(kenmerk: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:stat="http://logius.nl/digipoort/wus/2.0/statusinformatieservice/1.2">
  <soapenv:Header/>
  <soapenv:Body>
    <stat:getStatussenProces>
      <stat:kenmerk>${escapeXml(kenmerk)}</stat:kenmerk>
    </stat:getStatussenProces>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate a unique filing reference (kenmerk) for Digipoort.
 * Format: WS-{timestamp}-{random}
 */
function generateKenmerk(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `WS-${timestamp}-${random}`;
}

/** Pull a tag's text content out of a SOAP response without a full XML parser. */
function extractTag(xml: string, localName: string): string | null {
  const match = new RegExp(`<(?:[\\w-]+:)?${localName}[^>]*>([^<]*)</(?:[\\w-]+:)?${localName}>`).exec(xml);
  return match ? match[1].trim() : null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Submit an SBR filing to Digipoort.
 *
 * In 'simulated' mode the envelope is built and a fake kenmerk returned —
 * nothing leaves the worker. In 'preprod'/'production' the envelope is POSTed
 * through the mTLS certificate binding.
 */
export async function submitFiling(
  config: DigipoortConfig,
  xmlContent: string,
  berichtsoort = 'Omzetbelasting',
): Promise<DigipoortSubmitResult> {
  const kenmerk = generateKenmerk();
  const soapEnvelope = buildAanleverSoapEnvelope(config.btwNumber, xmlContent, kenmerk, berichtsoort);

  if (config.mode === 'simulated' || !config.fetcher) {
    if (config.mode !== 'simulated') {
      console.warn(
        '[Digipoort] DIGIPOORT_MODE is set but the DIGIPOORT_CERT mTLS binding is missing — falling back to simulated submission.',
      );
    }
    return {
      success: true,
      simulated: true,
      kenmerk,
      timestamp: new Date().toISOString(),
      rawResponse: `<!-- Simulated response. SOAP envelope was built but not sent. -->\n${soapEnvelope.slice(0, 500)}...`,
    };
  }

  try {
    const response = await config.fetcher.fetch(config.aanleverServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction:
          'http://logius.nl/digipoort/wus/2.0/aanleverservice/1.2/aanleverRequest',
      },
      body: soapEnvelope,
    });

    const rawResponse = await response.text();

    if (!response.ok) {
      const fault = extractTag(rawResponse, 'faultstring');
      return {
        success: false,
        error: fault ?? `Digipoort returned HTTP ${response.status}`,
        rawResponse,
      };
    }

    // Digipoort echoes the kenmerk in the aanleverResponse.
    const responseKenmerk = extractTag(rawResponse, 'kenmerk') ?? kenmerk;
    return {
      success: true,
      kenmerk: responseKenmerk,
      timestamp: new Date().toISOString(),
      rawResponse,
    };
  } catch (err) {
    console.error('[Digipoort] submission failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Digipoort submission failed',
    };
  }
}

/**
 * Check the status of a previously submitted filing via the
 * statusinformatieservice.
 *
 * Status code mapping: 0 → submitted, 100 → processing, 500 → accepted,
 * 400 → rejected.
 */
export async function checkFilingStatus(
  config: DigipoortConfig,
  kenmerk: string,
): Promise<DigipoortStatusResult> {
  const soapEnvelope = buildStatusSoapEnvelope(kenmerk);

  if (config.mode === 'simulated' || !config.fetcher) {
    return {
      success: true,
      simulated: true,
      status: 'submitted',
      statusDescription:
        'Simulated: filing has been submitted and is awaiting processing.',
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const response = await config.fetcher.fetch(config.statusServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction:
          'http://logius.nl/digipoort/wus/2.0/statusinformatieservice/1.2/getStatussenProces',
      },
      body: soapEnvelope,
    });

    const rawResponse = await response.text();
    if (!response.ok) {
      const fault = extractTag(rawResponse, 'faultstring');
      return {
        success: false,
        status: 'unknown',
        error: fault ?? `Digipoort returned HTTP ${response.status}`,
      };
    }

    const statusCode = extractTag(rawResponse, 'statuscode');
    const statusDescription = extractTag(rawResponse, 'statusomschrijving') ?? undefined;

    let status: DigipoortStatusResult['status'] = 'unknown';
    switch (statusCode) {
      case '0':
        status = 'submitted';
        break;
      case '100':
        status = 'processing';
        break;
      case '500':
        status = 'accepted';
        break;
      case '400':
        status = 'rejected';
        break;
    }

    return {
      success: true,
      status,
      statusDescription,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    console.error('[Digipoort] status check failed:', err);
    return {
      success: false,
      status: 'unknown',
      error: err instanceof Error ? err.message : 'Digipoort status check failed',
    };
  }
}

/**
 * Validate that a DigipoortConfig has the minimum required fields.
 */
export function validateConfig(
  config: Partial<DigipoortConfig>,
): config is DigipoortConfig {
  return !!(config.aanleverServiceUrl && config.statusServiceUrl && config.btwNumber);
}

/**
 * Build a DigipoortConfig from the worker environment. Mode/endpoints come
 * from DIGIPOORT_MODE; the mTLS fetcher from the DIGIPOORT_CERT binding.
 */
export function createConfig(env: DigipoortEnv, btwNumber: string): DigipoortConfig {
  const rawMode = (env.DIGIPOORT_MODE ?? 'simulated').toLowerCase();
  const mode: DigipoortMode =
    rawMode === 'production' ? 'production' : rawMode === 'preprod' ? 'preprod' : 'simulated';
  const endpoints =
    mode === 'production' ? DIGIPOORT_PRODUCTION_ENDPOINTS : DIGIPOORT_TEST_ENDPOINTS;

  return {
    ...endpoints,
    btwNumber,
    mode,
    fetcher: env.DIGIPOORT_CERT,
  };
}

/**
 * @deprecated Legacy signature kept for call-site compatibility during the
 * port — prefer `createConfig(env, btwNumber)`.
 */
export function createConfigFromSettings(options: {
  btwNumber: string;
  certificateBase64?: string;
  certificatePassword?: string;
  useProduction?: boolean;
}): DigipoortConfig {
  const endpoints = options.useProduction
    ? DIGIPOORT_PRODUCTION_ENDPOINTS
    : DIGIPOORT_TEST_ENDPOINTS;

  return {
    ...endpoints,
    btwNumber: options.btwNumber,
    mode: 'simulated',
  };
}
