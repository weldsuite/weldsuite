/**
 * The public API's (external-api, `/v1`) response schemas: WeldApps' token
 * grant and app storage, and the API's own index. Spread into ROUTES by
 * conformance-schemas.ts.
 */
import { z } from 'zod';
import type { RouteSchema } from './conformance-schemas';

const timestamp = z.string().datetime();

/** An `app_records` row. */
const appRecordSchema = z.object({
  id: z.string(),
  appCode: z.string(),
  collection: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdBy: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp.nullable(),
});

/** `{ key, value }` of an `app_kv` row. */
const appKvSchema = z.object({ key: z.string(), value: z.unknown() });

/** RFC 6749's token response (not the house envelope). */
const oauthTokenSchema = z.object({
  access_token: z.string().regex(/^wsat_[0-9a-f]{40}$/),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  scope: z.string(),
});

const workspaceRefSchema = z.object({ id: z.string(), tier: z.string() });

export const EXTERNAL_ROUTES: RouteSchema[] = [
  {
    method: 'GET',
    route: '/v1',
    envelope: 'single',
    data: z.object({ version: z.literal('v1'), workspace: workspaceRefSchema, endpoints: z.array(z.string()) }),
  },
  {
    method: 'GET',
    route: '/v1/health/db',
    envelope: 'single',
    data: z.object({ status: z.literal('connected'), workspace: workspaceRefSchema, timestamp }),
  },
  { method: 'POST', route: '/v1/oauth/token', envelope: 'body', data: oauthTokenSchema },
  { method: 'GET', route: '/v1/app-storage/collections/:collection/records', envelope: 'list', data: appRecordSchema },
  { method: 'POST', route: '/v1/app-storage/collections/:collection/records', envelope: 'single', data: appRecordSchema },
  { method: 'GET', route: '/v1/app-storage/collections/:collection/records/:id', envelope: 'single', data: appRecordSchema },
  { method: 'PATCH', route: '/v1/app-storage/collections/:collection/records/:id', envelope: 'single', data: appRecordSchema },
  { method: 'GET', route: '/v1/app-storage/kv/:key', envelope: 'single', data: appKvSchema },
  { method: 'PUT', route: '/v1/app-storage/kv/:key', envelope: 'single', data: appKvSchema },
];
