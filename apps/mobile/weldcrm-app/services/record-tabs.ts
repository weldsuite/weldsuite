/**
 * Data for the tabs on a company or person, the same sources the platform's
 * record panel reads:
 *
 *   emails     GET  /mail-messages?search=<email>          (mail-api; text match on the address)
 *   calls      GET  /calls?customerId= | contactId=        (call-api)
 *   meetings   GET  /meetings?counterpartyId= | personId=  (meet-api)
 *   files      GET  /files?entityType&entityId; upload = /storage/generate-upload-url → PUT → POST /files
 *   audit log  GET  /audit-logs/:entityType/:entityId
 *   chat       GET  /{companies|people}/:id/chat/channel; messages via /channels/:id/messages;
 *              the first message goes to /{companies|people}/:id/chat/messages, which creates the channel
 */

import type { ApiResponse } from '@weldsuite/mobile-ui/types';
import { appApiClient } from './app-api';
import { query } from './api';
import type { RecordRef } from './notes';

export interface EmailItem {
  id: string;
  subject: string;
  fromName?: string;
  fromEmail?: string;
  preview?: string;
  date: string;
  isRead: boolean;
  hasAttachments: boolean;
}

export interface CallItem {
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  number: string;
  startedAt: string;
  /** Seconds. */
  duration?: number;
}

export interface MeetingItem {
  id: string;
  title: string;
  status: string;
  start?: string;
  end?: string;
  attendeeCount: number;
}

export interface FileItem {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
  url?: string;
  createdAt: string;
}

export interface AuditItem {
  id: string;
  action: string;
  description: string;
  by?: string;
  changes: { field: string; from: string; to: string }[];
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  content: string;
  authorId?: string;
  authorName?: string;
  createdAt: string;
}

export interface PickedFile {
  name: string;
  uri: string;
  mimeType?: string;
}

const ok = <T>(data: T): ApiResponse<T> => ({ success: true, data });
const fail = <T>(err: unknown): ApiResponse<T> => ({
  success: false,
  error: err instanceof Error ? err.message : 'Request failed',
});

const recordPath = (record: Pick<RecordRef, 'kind' | 'id'>) =>
  `/${record.kind === 'company' ? 'companies' : 'people'}/${record.id}`;

/** Any value as short display text for the audit log ("—" for empty). */
export function auditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map(auditValue).join(', ');
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  }
  return String(value);
}

interface MailRow {
  id: string;
  subject?: string | null;
  from?: { name?: string | null; email?: string | null } | null;
  preview?: string | null;
  receivedDate?: string | null;
  sentDate?: string | null;
  createdAt: string;
  isRead?: boolean | null;
  hasAttachments?: boolean | null;
}

interface CallRow {
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  fromNumber: string;
  toNumber: string;
  fromNumberFormatted?: string | null;
  toNumberFormatted?: string | null;
  initiatedAt: string;
  duration?: number | null;
}

interface MeetingRow {
  id: string;
  title: string;
  status: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  attendees?: unknown[] | null;
  createdAt: string;
}

interface FileRow {
  id: string;
  name: string;
  mimeType?: string | null;
  fileSize?: number | null;
  url?: string | null;
  createdAt: string;
}

interface AuditRow {
  id: string;
  action: string;
  description?: string | null;
  performedByName?: string | null;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  createdAt: string;
}

interface ChatMessageRow {
  id: string;
  content: string;
  authorId?: string | null;
  authorName?: string | null;
  createdAt: string;
}

export function mapEmail(row: MailRow): EmailItem {
  return {
    id: row.id,
    subject: row.subject ?? '',
    fromName: row.from?.name ?? undefined,
    fromEmail: row.from?.email ?? undefined,
    preview: row.preview ?? undefined,
    date: row.receivedDate || row.sentDate || row.createdAt,
    isRead: row.isRead !== false,
    hasAttachments: !!row.hasAttachments,
  };
}

export function mapCall(row: CallRow): CallItem {
  const other =
    row.direction === 'inbound'
      ? row.fromNumberFormatted || row.fromNumber
      : row.toNumberFormatted || row.toNumber;
  return {
    id: row.id,
    direction: row.direction,
    status: row.status,
    number: other,
    startedAt: row.initiatedAt,
    duration: row.duration ?? undefined,
  };
}

export function mapAudit(row: AuditRow): AuditItem {
  return {
    id: row.id,
    action: row.action,
    description: row.description ?? '',
    by: row.performedByName ?? undefined,
    changes: Object.entries(row.changes ?? {}).map(([field, change]) => ({
      field,
      from: auditValue(change?.from),
      to: auditValue(change?.to),
    })),
    createdAt: row.createdAt,
  };
}

export const recordTabsApi = {
  async emails(email: string | undefined): Promise<ApiResponse<EmailItem[]>> {
    if (!email?.trim()) return ok([]);
    try {
      const res = await appApiClient.get<{ data: MailRow[] }>(`/mail-messages${query({ search: email.trim(), limit: 50 })}`);
      return ok(res.data.map(mapEmail));
    } catch (err) {
      return fail(err);
    }
  },

  async calls(record: Pick<RecordRef, 'kind' | 'id'>): Promise<ApiResponse<CallItem[]>> {
    try {
      const res = await appApiClient.get<{ data: CallRow[] }>(
        `/calls${query({
          customerId: record.kind === 'company' ? record.id : undefined,
          // call-api has no personId filter; a person's calls are stored as contactId.
          contactId: record.kind === 'person' ? record.id : undefined,
          limit: 50,
        })}`,
      );
      return ok(res.data.map(mapCall));
    } catch (err) {
      return fail(err);
    }
  },

  async meetings(record: Pick<RecordRef, 'kind' | 'id'>): Promise<ApiResponse<MeetingItem[]>> {
    try {
      const res = await appApiClient.get<{ data: MeetingRow[] }>(
        `/meetings${query({
          counterpartyId: record.kind === 'company' ? record.id : undefined,
          personId: record.kind === 'person' ? record.id : undefined,
          limit: 50,
        })}`,
      );
      return ok(
        res.data.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          start: row.scheduledStart ?? undefined,
          end: row.scheduledEnd ?? undefined,
          attendeeCount: row.attendees?.length ?? 0,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  async files(record: Pick<RecordRef, 'kind' | 'id'>): Promise<ApiResponse<FileItem[]>> {
    try {
      const res = await appApiClient.get<{ data: FileRow[] }>(
        `/files${query({ entityType: record.kind, entityId: record.id, pageSize: 100 })}`,
      );
      return ok(
        res.data.map((row) => ({
          id: row.id,
          name: row.name,
          mimeType: row.mimeType ?? undefined,
          size: row.fileSize ?? undefined,
          url: row.url ?? undefined,
          createdAt: row.createdAt,
        })),
      );
    } catch (err) {
      return fail(err);
    }
  },

  /** Upload a picked file and attach it to the record, the way the web's Files tab does. */
  async uploadFile(record: Pick<RecordRef, 'kind' | 'id'>, file: PickedFile): Promise<ApiResponse<null>> {
    try {
      const local = await fetch(file.uri);
      if (!local.ok) throw new Error(`Could not read "${file.name}"`);
      const blob = await local.blob();
      const contentType = file.mimeType || blob.type || 'application/octet-stream';
      const gen = await appApiClient.post<{ uploadUrl?: string; fileKey?: string }>('/storage/generate-upload-url', {
        fileName: file.name,
        contentType,
        fileSize: blob.size,
        folder: 'documents',
        entityType: record.kind,
        entityId: record.id,
        isPublic: false,
      });
      if (!gen.uploadUrl || !gen.fileKey) throw new Error(`Upload URL unavailable for "${file.name}"`);
      // The URL's token authorises the write: a plain PUT of the bytes.
      const put = await fetch(gen.uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': contentType } });
      if (!put.ok) throw new Error(`Upload failed for "${file.name}" (${put.status})`);
      await appApiClient.post('/files', {
        fileName: file.name,
        mimeType: contentType,
        fileSize: blob.size,
        fileType: 'file',
        storagePath: gen.fileKey,
        fileKey: gen.fileKey,
        entityType: record.kind,
        entityId: record.id,
      });
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async deleteFile(id: string): Promise<ApiResponse<null>> {
    try {
      await appApiClient.delete(`/files/${id}`);
      return ok(null);
    } catch (err) {
      return fail(err);
    }
  },

  async auditLog(record: Pick<RecordRef, 'kind' | 'id'>): Promise<ApiResponse<AuditItem[]>> {
    try {
      const res = await appApiClient.get<{ data: AuditRow[] }>(`/audit-logs/${record.kind}/${record.id}?limit=100`);
      return ok(res.data.map(mapAudit));
    } catch (err) {
      return fail(err);
    }
  },

  /** The record's chat messages, oldest first; empty while it has no channel yet. */
  async chat(record: Pick<RecordRef, 'kind' | 'id'>): Promise<ApiResponse<{ channelId: string | null; messages: ChatMessage[] }>> {
    try {
      const channel = await appApiClient.get<{ data: { id: string } | null }>(`${recordPath(record)}/chat/channel`);
      if (!channel.data) return ok({ channelId: null, messages: [] });
      const res = await appApiClient.get<{ data: { messages: ChatMessageRow[] } }>(
        `/channels/${channel.data.id}/messages?limit=50`,
      );
      const messages = res.data.messages
        .map((row) => ({
          id: row.id,
          content: row.content,
          authorId: row.authorId ?? undefined,
          authorName: row.authorName ?? undefined,
          createdAt: row.createdAt,
        }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return ok({ channelId: channel.data.id, messages });
    } catch (err) {
      return fail(err);
    }
  },

  async sendChat(
    record: Pick<RecordRef, 'kind' | 'id'>,
    channelId: string | null,
    content: string,
  ): Promise<ApiResponse<{ channelId: string }>> {
    try {
      if (channelId) {
        await appApiClient.post(`/channels/${channelId}/messages`, { content });
        return ok({ channelId });
      }
      const res = await appApiClient.post<{ data: { channel: { id: string } } }>(`${recordPath(record)}/chat/messages`, {
        content,
      });
      return ok({ channelId: res.data.channel.id });
    } catch (err) {
      return fail(err);
    }
  },
};
