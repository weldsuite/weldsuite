import { describe, expect, it } from 'vitest';
import {
  attachmentDownloadFailure,
  attachmentScanState,
  isAttachmentDownloadable,
  isAttachmentForwardable,
} from './attachment-scan';
import { summarizeThreats } from './mail-threats';

describe('attachmentScanState', () => {
  it('reads clean, unscanned and absent scan fields as normal', () => {
    expect(attachmentScanState({ scanStatus: 'clean' })).toBe('normal');
    expect(attachmentScanState({ scanStatus: null })).toBe('normal');
    expect(attachmentScanState({})).toBe('normal');
  });

  it('maps the blocking and warning states', () => {
    expect(attachmentScanState({ scanStatus: 'infected', scanSignature: 'Win.Test.EICAR_HDB-1' })).toBe('infected');
    expect(attachmentScanState({ scanStatus: 'pending' })).toBe('pending');
    expect(attachmentScanState({ scanStatus: 'error' })).toBe('scan-failed');
  });
});

describe('downloadable and forwardable', () => {
  it('holds back infected and pending files only', () => {
    expect(isAttachmentDownloadable({ scanStatus: 'infected' })).toBe(false);
    expect(isAttachmentDownloadable({ scanStatus: 'pending' })).toBe(false);
    expect(isAttachmentDownloadable({ scanStatus: 'error' })).toBe(true);
    expect(isAttachmentDownloadable({ scanStatus: 'clean' })).toBe(true);
    expect(isAttachmentDownloadable({})).toBe(true);
    expect(isAttachmentForwardable({ scanStatus: 'infected' })).toBe(false);
    expect(isAttachmentForwardable({ scanStatus: 'pending' })).toBe(false);
  });
});

describe('attachmentDownloadFailure', () => {
  it('maps the 403 and 409 error codes', () => {
    expect(attachmentDownloadFailure('ATTACHMENT_INFECTED')).toBe('infected');
    expect(attachmentDownloadFailure('ATTACHMENT_SCAN_PENDING')).toBe('scan-pending');
    expect(attachmentDownloadFailure('NOT_FOUND')).toBe('other');
    expect(attachmentDownloadFailure(undefined)).toBe('other');
  });
});

describe('summarizeThreats', () => {
  it('is null without threats', () => {
    expect(summarizeThreats(null)).toBeNull();
    expect(summarizeThreats(undefined)).toBeNull();
    expect(summarizeThreats([])).toBeNull();
  });

  it('is a danger for an infected file or a malicious link', () => {
    expect(
      summarizeThreats([
        { kind: 'attachment', verdict: 'infected', fileName: 'invoice.exe', attachmentId: 'a1', signature: 'Win.Test.EICAR_HDB-1' },
      ]),
    ).toEqual({
      severity: 'danger',
      files: [{ fileName: 'invoice.exe', signature: 'Win.Test.EICAR_HDB-1' }],
      links: [],
    });
    expect(
      summarizeThreats([{ kind: 'link', verdict: 'malicious', url: 'https://bad.example/x', reason: 'threat_feed' }])?.severity,
    ).toBe('danger');
  });

  it('is only a warning for suspicious links, listed once per host', () => {
    const summary = summarizeThreats([
      { kind: 'link', verdict: 'suspicious', url: 'http://1.2.3.4/a', reason: 'ip_host' },
      { kind: 'link', verdict: 'suspicious', url: 'http://1.2.3.4/b', reason: 'ip_host' },
    ]);
    expect(summary).toEqual({ severity: 'warning', files: [], links: [{ host: '1.2.3.4', verdict: 'suspicious' }] });
  });

  it('lists dangerous links before suspicious ones', () => {
    const summary = summarizeThreats([
      { kind: 'link', verdict: 'suspicious', url: 'https://odd.example/', reason: 'homograph' },
      { kind: 'link', verdict: 'malicious', url: 'https://bad.example/', reason: 'threat_feed', threat: 'phishing' },
    ]);
    expect(summary?.links.map((link) => link.host)).toEqual(['bad.example', 'odd.example']);
  });
});
