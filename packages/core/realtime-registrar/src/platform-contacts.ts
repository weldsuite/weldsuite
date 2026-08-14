/**
 * WeldSuite-owned Realtime Register contact handles.
 *
 * Registry and registrar mail follow the handles on the domain. Customer
 * emails must never be sent as registrant / admin / tech / billing, or the
 * TLD and Realtime Register will email the customer directly. Store the
 * real contact on `host_domains.registrantContact` in the tenant DB only.
 */

export type PlatformRegistrarContactEnv = {
  admin?: string | null;
  tech?: string | null;
  billing?: string | null;
};

export type PlatformRoleContact = {
  role: 'ADMIN' | 'BILLING' | 'TECH';
  handle: string;
};

export type PlatformRegistrarContacts = {
  registrant: string;
  contacts: PlatformRoleContact[];
};

export class MissingPlatformRegistrantError extends Error {
  constructor() {
    super(
      'REALTIME_REGISTER_CONTACT_ADMIN is not set — WeldHost registers domains on platform contacts so customers are not emailed by the registrar or TLD',
    );
    this.name = 'MissingPlatformRegistrantError';
  }
}

/** WHOIS/RDAP privacy is always requested so public output does not expose platform staff. */
export const WELDHOST_PRIVACY_PROTECT = true;

export function resolvePlatformRegistrarContacts(
  env: PlatformRegistrarContactEnv,
): PlatformRegistrarContacts {
  const admin = env.admin?.trim() ?? '';
  if (!admin) {
    throw new MissingPlatformRegistrantError();
  }
  const tech = env.tech?.trim() || admin;
  const billing = env.billing?.trim() || admin;
  return {
    registrant: admin,
    contacts: [
      { role: 'ADMIN', handle: admin },
      { role: 'TECH', handle: tech },
      { role: 'BILLING', handle: billing },
    ],
  };
}
