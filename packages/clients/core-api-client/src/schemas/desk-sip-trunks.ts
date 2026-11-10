import { z } from 'zod';

// These lists mirror packages/core/db/src/schema/voip-sip-trunks.ts (this
// package does not depend on @weldsuite/db); call-api's sip-trunk tests check
// they stay equal.
export const DESK_SIP_TRUNK_PROVIDERS = ['xelion', 'dstny', 'other'] as const;
export const DESK_SIP_TRUNK_AUTH_MODES = ['ip', 'credentials'] as const;
export const DESK_SIP_TRUNK_TRANSPORTS = ['udp', 'tcp', 'tls'] as const;
export const DESK_SIP_TRUNK_STATUSES = ['active', 'disabled'] as const;
export const DESK_SIP_TRUNK_MAX_IP_ADDRESSES = 10;
export const DESK_SIP_VERIFICATION_METHODS = ['call', 'sms'] as const;

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Must be E.164');

/** A public IPv4 address (dotted quad); private ranges are refused server-side. */
const ipv4 = z
  .string()
  .trim()
  .regex(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, 'Must be an IPv4 address')
  .refine((v) => v.split('.').every((p) => Number(p) <= 255), 'Must be an IPv4 address');

export const deskSipTrunkIpAddressInputSchema = z.object({
  ip: ipv4,
  port: z.number().int().min(1).max(65535).optional(),
});

export const createDeskSipTrunkSchema = z.object({
  name: z.string().trim().min(1).max(255),
  provider: z.enum(DESK_SIP_TRUNK_PROVIDERS).default('other'),
  authMode: z.enum(DESK_SIP_TRUNK_AUTH_MODES),
  transport: z.enum(DESK_SIP_TRUNK_TRANSPORTS).optional(),
  ipAddresses: z.array(deskSipTrunkIpAddressInputSchema).max(DESK_SIP_TRUNK_MAX_IP_ADDRESSES).optional(),
});

export const updateDeskSipTrunkSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  provider: z.enum(DESK_SIP_TRUNK_PROVIDERS).optional(),
  status: z.enum(DESK_SIP_TRUNK_STATUSES).optional(),
  transport: z.enum(DESK_SIP_TRUNK_TRANSPORTS).optional(),
  ipAddresses: z.array(deskSipTrunkIpAddressInputSchema).max(DESK_SIP_TRUNK_MAX_IP_ADDRESSES).optional(),
});

export const addDeskSipTrunkNumberSchema = z.object({
  phoneNumber: z.string().trim().min(1).max(50),
  displayName: z.string().trim().max(100).nullable().optional(),
});

export const startDeskSipVerificationSchema = z.object({
  method: z.enum(DESK_SIP_VERIFICATION_METHODS),
});

export const confirmDeskSipVerificationSchema = z.object({
  code: z.string().trim().regex(/^\d{4,10}$/, 'Enter the numeric code'),
});

export type CreateDeskSipTrunkInput = z.infer<typeof createDeskSipTrunkSchema>;
export type UpdateDeskSipTrunkInput = z.infer<typeof updateDeskSipTrunkSchema>;
export type AddDeskSipTrunkNumberInput = z.infer<typeof addDeskSipTrunkNumberSchema>;
export type DeskSipVerificationMethod = (typeof DESK_SIP_VERIFICATION_METHODS)[number];

// ── Responses ─────────────────────────────────────────────────────────────

export const deskSipTrunkIpAddressSchema = z
  .object({
    ip: z.string(),
    port: z.number().int().optional(),
  })
  .strict();

export const deskSipTrunkNumberSchema = z
  .object({
    id: z.string(),
    phoneNumber: z.string(),
    displayName: z.string().nullable(),
    status: z.string(),
    allowOutbound: z.boolean(),
    callerIdVerifiedAt: z.string().nullable(),
  })
  .strict();

export const deskSipConnectionDetailsSchema = z
  .object({
    /** Where the phone system sends calls, one host per region. */
    sipHosts: z.array(z.object({ region: z.string(), host: z.string() }).strict()),
    primaryHost: z.string(),
    /** Port for the trunk's transport (5060, or 5061 for TLS). */
    port: z.number().int(),
    transport: z.enum(DESK_SIP_TRUNK_TRANSPORTS),
    /** The login of a `credentials` trunk; null for an `ip` trunk. */
    username: z.string().nullable(),
    /** Addresses to allow-list in the phone system's firewall. */
    signalingIps: z.array(z.object({ region: z.string(), ip: z.string() }).strict()),
  })
  .strict();

export const deskSipTrunkSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    name: z.string(),
    provider: z.enum(DESK_SIP_TRUNK_PROVIDERS),
    authMode: z.enum(DESK_SIP_TRUNK_AUTH_MODES),
    transport: z.enum(DESK_SIP_TRUNK_TRANSPORTS),
    status: z.enum(DESK_SIP_TRUNK_STATUSES),
    ipAddresses: z.array(deskSipTrunkIpAddressSchema),
    lastInboundAt: z.string().nullable(),
    lastError: z.string().nullable(),
    numbers: z.array(deskSipTrunkNumberSchema),
    connection: deskSipConnectionDetailsSchema,
  })
  .strict();

/** `POST /` and `POST /:id/rotate-password`: the one time the password is returned. */
export const deskSipTrunkCredentialsSchema = z.object({ username: z.string(), password: z.string() }).strict();

export const deskSipTrunkCreatedSchema = deskSipTrunkSchema.extend({
  credentials: deskSipTrunkCredentialsSchema.nullable(),
});

export const deskSipTrunkRotatedSchema = z.object({ credentials: deskSipTrunkCredentialsSchema }).strict();

export const deskSipVerificationStartedSchema = z
  .object({ method: z.enum(DESK_SIP_VERIFICATION_METHODS), phoneNumber: z.string() })
  .strict();

export const deskSipTrunkNumberVerifiedSchema = deskSipTrunkNumberSchema;

export type DeskSipTrunk = z.infer<typeof deskSipTrunkSchema>;
export type DeskSipTrunkNumber = z.infer<typeof deskSipTrunkNumberSchema>;
export type DeskSipTrunkCreated = z.infer<typeof deskSipTrunkCreatedSchema>;
export type DeskSipTrunkCredentials = z.infer<typeof deskSipTrunkCredentialsSchema>;
export type DeskSipConnectionDetails = z.infer<typeof deskSipConnectionDetailsSchema>;

export { e164 as deskSipE164Schema };
