import { describe, expect, it } from 'vitest';
import { parseKeyRecord, parseSnapshotRequest, snapshotRequestKvKey } from './registry';

describe('secret key record', () => {
  it('parses a stored record and rejects the rest', () => {
    const record = { v: 1, keyId: 'pnk_1', workspaceId: 'ws_1', projectId: 'pnp_1' };
    expect(parseKeyRecord(JSON.stringify(record))).toEqual(record);
    expect(parseKeyRecord(null)).toBeNull();
    expect(parseKeyRecord('nope')).toBeNull();
    expect(parseKeyRecord(JSON.stringify({ ...record, v: 2 }))).toBeNull();
    expect(parseKeyRecord(JSON.stringify({ v: 1, keyId: 'pnk_1' }))).toBeNull();
  });

  it('carries the project status, and treats a missing or unknown one as active', () => {
    const record = { v: 1, keyId: 'pnk_1', workspaceId: 'ws_1', projectId: 'pnp_1' };
    expect(parseKeyRecord(JSON.stringify({ ...record, status: 'paused' }))?.status).toBe('paused');
    expect(parseKeyRecord(JSON.stringify({ ...record, status: 'active' }))?.status).toBe('active');
    expect(parseKeyRecord(JSON.stringify(record))?.status).toBeUndefined();
    expect(parseKeyRecord(JSON.stringify({ ...record, status: 'weird' }))?.status).toBeUndefined();
  });
});

describe('snapshot request', () => {
  const request = { pageGroupId: 'pnh_abc-1', urlPattern: '/products/*', deviceClass: 'mobile' };

  it('has its own KV key', () => {
    expect(snapshotRequestKvKey('pnp_1')).toBe('panel:snapshot-request:pnp_1');
  });

  it('parses a valid request', () => {
    expect(parseSnapshotRequest(JSON.stringify(request))).toEqual(request);
  });

  it('rejects a missing, malformed or unsafe request', () => {
    expect(parseSnapshotRequest(null)).toBeNull();
    expect(parseSnapshotRequest('{')).toBeNull();
    expect(parseSnapshotRequest(JSON.stringify({ ...request, deviceClass: 'phone' }))).toBeNull();
    expect(parseSnapshotRequest(JSON.stringify({ ...request, urlPattern: '' }))).toBeNull();
    expect(parseSnapshotRequest(JSON.stringify({ ...request, pageGroupId: '../etc' }))).toBeNull();
  });
});
