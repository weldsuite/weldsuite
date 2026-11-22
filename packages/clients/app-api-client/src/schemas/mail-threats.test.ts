import { describe, expect, it } from 'vitest';
import { createMailMessagesApi } from '../domains/mail-messages';
import { RESPONSE, recordingApi } from '../domains/recording-api.test-helper';
import {
  MAIL_ATTACHMENT_DOWNLOAD_ERROR_CODES,
  mailAttachmentScanSchema,
  mailAttachmentScanStatusSchema,
} from './mail-attachments';
import { mailLinkCheckResultSchema, mailLinkCheckSchema, mailThreatSchema, mailThreatsSchema } from './mail-messages';

describe('attachment scan fields', () => {
  it('accepts every scan status and absent fields (Global sends none)', () => {
    for (const status of ['clean', 'infected', 'pending', 'error'] as const) {
      expect(mailAttachmentScanStatusSchema.parse(status)).toBe(status);
    }
    expect(mailAttachmentScanSchema.parse({})).toEqual({});
    expect(
      mailAttachmentScanSchema.parse({ scanStatus: 'infected', scanSignature: 'Eicar-Signature', scannedAt: null }),
    ).toEqual({ scanStatus: 'infected', scanSignature: 'Eicar-Signature', scannedAt: null });
    expect(mailAttachmentScanStatusSchema.safeParse('quarantined').success).toBe(false);
  });

  it('names the download refusals the server sends', () => {
    expect(MAIL_ATTACHMENT_DOWNLOAD_ERROR_CODES).toEqual({
      infected: 'ATTACHMENT_INFECTED',
      scanPending: 'ATTACHMENT_SCAN_PENDING',
    });
  });
});

describe('message threats', () => {
  it('reads infected files and dangerous links', () => {
    const threats = mailThreatsSchema.parse([
      { kind: 'attachment', verdict: 'infected', fileName: 'invoice.exe', attachmentId: 'attach_1', signature: 'Eicar' },
      {
        kind: 'link',
        verdict: 'malicious',
        url: 'https://evil.test/',
        reason: 'threat_feed',
        source: 'feed',
        threat: 'phishing',
      },
      { kind: 'link', verdict: 'suspicious', url: 'http://192.0.2.1/', reason: 'ip_host' },
    ]);
    expect(threats).toHaveLength(3);
    expect(mailThreatsSchema.parse(null)).toBeNull();
    expect(mailThreatsSchema.parse(undefined)).toBeUndefined();
  });

  it('refuses entries the server never sends', () => {
    expect(mailThreatSchema.safeParse({ kind: 'attachment', verdict: 'malicious', fileName: 'a', signature: 's' }).success).toBe(
      false,
    );
    expect(mailThreatSchema.safeParse({ kind: 'link', verdict: 'safe', url: 'https://a.test/', reason: 'ip_host' }).success).toBe(
      false,
    );
    expect(mailThreatSchema.safeParse({ kind: 'note' }).success).toBe(false);
  });
});

describe('link check', () => {
  it('bounds the request and reads the verdict', () => {
    expect(mailLinkCheckSchema.safeParse({ url: '' }).success).toBe(false);
    expect(mailLinkCheckSchema.safeParse({ url: `https://a.test/${'x'.repeat(4096)}` }).success).toBe(false);
    expect(mailLinkCheckSchema.safeParse({ url: 'https://a.test/', text: 'y'.repeat(501) }).success).toBe(false);
    expect(mailLinkCheckSchema.parse({ url: 'https://a.test/', text: 'A' })).toEqual({ url: 'https://a.test/', text: 'A' });
    expect(
      mailLinkCheckResultSchema.parse({
        url: 'https://evil.test/',
        verdict: 'malicious',
        reasons: [{ code: 'threat_feed', source: 'feed', threat: 'malware' }],
      }).verdict,
    ).toBe('malicious');
    expect(mailLinkCheckResultSchema.safeParse({ url: 'https://a.test/', verdict: 'unknown', reasons: [] }).success).toBe(false);
  });

  it('posts to the message link-check route', async () => {
    const { api, calls } = recordingApi();
    const result = await createMailMessagesApi(api).linkCheck('msg_1', { url: 'https://a.test/', text: 'A' });
    expect(calls).toEqual([
      { method: 'POST', path: '/mail-messages/msg_1/link-check', body: { url: 'https://a.test/', text: 'A' } },
    ]);
    expect(result).toBe(RESPONSE);
  });
});
