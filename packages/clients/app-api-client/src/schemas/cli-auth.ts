import { z } from 'zod';

// ============================================================================
// CLI device-code login — /api/cli-auth/* (`weld login`)
// ============================================================================

/** `POST /api/cli-auth/device`: a pending session's codes. */
export const cliAuthDeviceSchema = z.object({
  deviceCode: z.string(),
  /** `XXXX-XXXX`, for the developer portal. */
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  expiresIn: z.number().int(),
  interval: z.number().int(),
});

/** `POST /api/cli-auth/token`: still pending, or the minted key (once). */
export const cliAuthTokenSchema = z.union([
  z.object({ status: z.literal('pending'), interval: z.number().int() }),
  z.object({
    status: z.literal('complete'),
    apiKey: z.string(),
    keyId: z.string(),
    keyPrefix: z.string(),
    orgId: z.string(),
    orgName: z.string().nullable(),
    userId: z.string(),
    email: z.string().nullable(),
    apiUrl: z.string(),
  }),
]);

/** `POST /api/cli-auth/approve`. */
export const cliAuthApproveSchema = z.union([
  z.object({ status: z.literal('complete'), alreadyApproved: z.literal(true) }),
  z.object({
    status: z.literal('complete'),
    keyPrefix: z.string(),
    orgId: z.string(),
    orgName: z.string().nullable(),
    email: z.string().nullable(),
  }),
]);
