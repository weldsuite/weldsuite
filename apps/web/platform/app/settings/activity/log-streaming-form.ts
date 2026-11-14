/**
 * The form of one audit log stream (Settings → Activity → Log streaming):
 * its schema, how a stream becomes form values, and how the values become the
 * body of `POST` / `PATCH /api/audit-log-streams`.
 *
 * The token is write-only. Editing never prefills it; the body carries it only
 * when the member typed a new one (replace) or asked to drop the saved one
 * (`null`).
 */

import { z } from 'zod';
import {
  AUDIT_LOG_STREAM_FORMATS,
  auditLogStreamTypeSchema,
  type AuditLogStream,
  type AuditLogStreamSettings,
  type CreateAuditLogStreamInput,
  type UpdateAuditLogStreamInput,
} from '@weldsuite/core-api-client/schemas/audit-log-streams';

/** What happens to the saved token when an existing stream is saved. */
export type TokenAction = 'keep' | 'replace' | 'remove';

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;

export interface StreamFormCopy {
  nameRequired: string;
  urlRequired: string;
  authHeaderInvalid: string;
}

export function buildStreamFormSchema(copy: StreamFormCopy) {
  return z.object({
    name: z.string().trim().min(1, copy.nameRequired).max(255),
    type: auditLogStreamTypeSchema,
    url: z.string().trim().min(1, copy.urlRequired).max(2048),
    token: z.string().max(2048),
    index: z.string().max(255),
    source: z.string().max(255),
    sourcetype: z.string().max(255),
    host: z.string().max(255),
    authHeader: z
      .string()
      .trim()
      .refine((value) => value === '' || HEADER_NAME.test(value), copy.authHeaderInvalid),
    format: z.enum(AUDIT_LOG_STREAM_FORMATS),
  });
}

export type StreamFormValues = z.infer<ReturnType<typeof buildStreamFormSchema>>;

export const EMPTY_STREAM_FORM: StreamFormValues = {
  name: '',
  type: 'splunk_hec',
  url: '',
  token: '',
  index: '',
  source: '',
  sourcetype: '',
  host: '',
  authHeader: '',
  format: 'json',
};

export function valuesFromStream(stream: AuditLogStream): StreamFormValues {
  const settings = stream.settings ?? {};
  return {
    name: stream.name,
    type: stream.type,
    url: stream.url,
    token: '',
    index: settings.index ?? '',
    source: settings.source ?? '',
    sourcetype: settings.sourcetype ?? '',
    host: settings.host ?? '',
    authHeader: settings.authHeader ?? '',
    format: settings.format ?? 'json',
  };
}

/** Only the settings of the chosen type, and only the ones that are filled in. */
export function settingsFromValues(values: StreamFormValues): AuditLogStreamSettings | null {
  const settings: AuditLogStreamSettings = {};
  if (values.type === 'splunk_hec') {
    if (values.index.trim()) settings.index = values.index.trim();
    if (values.source.trim()) settings.source = values.source.trim();
    if (values.sourcetype.trim()) settings.sourcetype = values.sourcetype.trim();
    if (values.host.trim()) settings.host = values.host.trim();
  } else {
    if (values.authHeader.trim()) settings.authHeader = values.authHeader.trim();
    // One JSON document is the default, so it is not stored.
    if (values.format === 'ndjson') settings.format = 'ndjson';
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

export function toCreateInput(values: StreamFormValues): CreateAuditLogStreamInput {
  const settings = settingsFromValues(values);
  return {
    name: values.name.trim(),
    type: values.type,
    url: values.url.trim(),
    ...(values.token ? { token: values.token } : {}),
    ...(settings ? { settings } : {}),
  };
}

/** A save replaces the settings (`null` clears them) and touches the token only on request. */
export function toUpdateInput(values: StreamFormValues, tokenAction: TokenAction): UpdateAuditLogStreamInput {
  const input: UpdateAuditLogStreamInput = {
    name: values.name.trim(),
    type: values.type,
    url: values.url.trim(),
    settings: settingsFromValues(values),
  };
  if (tokenAction === 'remove') input.token = null;
  else if (tokenAction === 'replace' && values.token) input.token = values.token;
  return input;
}

/** The host of a destination, for the list (the full URL can carry a secret in its path). */
export function destinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
