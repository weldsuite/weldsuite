/**
 * What a customer's phone system needs to reach Telnyx. Kept in one place
 * because the addresses must be re-checked against Telnyx's own list.
 *
 * Source: https://sip.telnyx.com/voice.json (and Telnyx's "SIP trunking
 * connectivity" docs). Last checked 2026-11-10.
 */

export const DEFAULT_SIP_HOST = 'sip.telnyx.com';

/** Where a PBX sends calls, per region. */
export const TELNYX_SIP_HOSTS = [
  { region: 'US', host: 'sip.telnyx.com' },
  { region: 'EU', host: 'sip.telnyx.eu' },
] as const;

/* eslint-disable sonarjs/no-hardcoded-ip -- Telnyx's published SIP signalling addresses, shown to the customer to allow-list in their firewall: data, not an address this code connects to. */
/** Signalling IPs a PBX may need to allow-list. */
export const TELNYX_SIGNALING_IPS = [
  { region: 'US', ip: '192.76.120.10' },
  { region: 'US', ip: '64.16.250.10' },
  { region: 'EU', ip: '185.246.41.140' },
  { region: 'EU', ip: '185.246.41.141' },
] as const;
/* eslint-enable sonarjs/no-hardcoded-ip */

export const SIP_PORT_PLAIN = 5060;
export const SIP_PORT_TLS = 5061;

export const SIP_TRANSPORT_TO_TELNYX = { udp: 'UDP', tcp: 'TCP', tls: 'TLS' } as const;
