/**
 * The "Connect a phone system" form: its values, their check and the request
 * they turn into. Pure, so the wizard only renders.
 */

import {
  DESK_SIP_TRUNK_MAX_IP_ADDRESSES,
  type CreateDeskSipTrunkInput,
} from '@weldsuite/core-api-client/schemas/desk-sip-trunks';

export type SipProvider = CreateDeskSipTrunkInput['provider'];
export type SipAuthMode = CreateDeskSipTrunkInput['authMode'];
export type SipTransport = NonNullable<CreateDeskSipTrunkInput['transport']>;

export interface SipIpRow {
  ip: string;
  /** Empty means the default port. */
  port: string;
}

export interface SipTrunkFormValues {
  name: string;
  provider: SipProvider;
  authMode: SipAuthMode;
  transport: SipTransport;
  ips: SipIpRow[];
}

export const MAX_IPS = DESK_SIP_TRUNK_MAX_IP_ADDRESSES;

export function emptySipTrunkForm(): SipTrunkFormValues {
  return { name: '', provider: 'xelion', authMode: 'ip', transport: 'udp', ips: [{ ip: '', port: '' }] };
}

export type SipFormError =
  | { kind: 'name' }
  | { kind: 'ipRequired' }
  | { kind: 'ip'; index: number; ip: string }
  | { kind: 'port'; index: number };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(value: string): boolean {
  const m = IPV4.exec(value.trim());
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

/** Checks of the IP rows; blank rows are ignored. */
export function validateIpRows(rows: readonly SipIpRow[], needOne: boolean): SipFormError[] {
  const errors: SipFormError[] = [];
  const filled = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.ip.trim() !== '' || row.port.trim() !== '');
  if (needOne && filled.length === 0) errors.push({ kind: 'ipRequired' });
  for (const { row, index } of filled) {
    if (!isIpv4(row.ip)) errors.push({ kind: 'ip', index, ip: row.ip.trim() });
    const port = row.port.trim();
    if (port !== '' && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65_535)) {
      errors.push({ kind: 'port', index });
    }
  }
  return errors;
}

export function validateSipTrunkForm(values: SipTrunkFormValues): SipFormError[] {
  const errors: SipFormError[] = [];
  if (values.name.trim() === '') errors.push({ kind: 'name' });
  if (values.authMode === 'ip') errors.push(...validateIpRows(values.ips, true));
  return errors;
}

/** The request for filled IP rows. */
export function ipRowsToInput(rows: readonly SipIpRow[]): Array<{ ip: string; port?: number }> {
  return rows
    .filter((row) => row.ip.trim() !== '')
    .map((row) => ({ ip: row.ip.trim(), ...(row.port.trim() !== '' ? { port: Number(row.port) } : {}) }));
}

export function sipTrunkFormToInput(values: SipTrunkFormValues): CreateDeskSipTrunkInput {
  return {
    name: values.name.trim(),
    provider: values.provider,
    authMode: values.authMode,
    transport: values.transport,
    ...(values.authMode === 'ip' ? { ipAddresses: ipRowsToInput(values.ips) } : {}),
  };
}

export function ipRowsOf(addresses: ReadonlyArray<{ ip: string; port?: number }>): SipIpRow[] {
  const rows = addresses.map((a) => ({ ip: a.ip, port: a.port === undefined ? '' : String(a.port) }));
  return rows.length > 0 ? rows : [{ ip: '', port: '' }];
}
