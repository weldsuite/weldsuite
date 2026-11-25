import { describe, expect, it } from 'vitest';
import {
  createRecipientSchema,
  signCapabilitiesSchema,
  signSignatureInfoSchema,
} from '../schemas/weldsign';
import { createWeldSignApi } from './weldsign';
import { RESPONSE, recordingApi } from './recording-api.test-helper';

describe('WeldSign eIDAS client', () => {
  it('asks the install what it offers', async () => {
    const { api, calls } = recordingApi();
    const result = await createWeldSignApi(api).capabilities();
    expect(calls).toEqual([{ method: 'GET', path: '/sign/capabilities', body: undefined }]);
    expect(result).toBe(RESPONSE);
  });

  it('lists the signatures of a request', async () => {
    const { api, calls } = recordingApi();
    await createWeldSignApi(api).signatures('sgn_1');
    expect(calls).toEqual([{ method: 'GET', path: '/sign/envelopes/sgn_1/signatures', body: undefined }]);
  });

  it('downloads the evidence report as raw bytes', async () => {
    const { api } = recordingApi();
    const paths: string[] = [];
    api.getRaw = (path: string) => {
      paths.push(path);
      return Promise.resolve(new Response('pdf'));
    };
    const response = await createWeldSignApi(api).evidence('sgn_1');
    expect(paths).toEqual(['/sign/envelopes/sgn_1/evidence']);
    expect(await response.text()).toBe('pdf');
  });
});

describe('WeldSign eIDAS schemas', () => {
  it('reads the capabilities', () => {
    const parsed = signCapabilitiesSchema.parse({
      seal: true,
      levels: ['ses', 'qes'],
      provider: 'Test QTSP',
      prices: { aes: null, qes: 300 },
    });
    expect(parsed.levels).toEqual(['ses', 'qes']);
    expect(signCapabilitiesSchema.safeParse({ seal: true, levels: ['xes'], provider: null, prices: { aes: null, qes: null } }).success).toBe(
      false,
    );
  });

  it('reads a signature row', () => {
    const row = {
      id: 'sgs_1',
      kind: 'signature',
      level: 'qes',
      recipientId: 'sgr_1',
      holderName: 'Ann Peeters',
      issuerName: 'Test CA',
      provider: 'Test QTSP',
      qualified: true,
      signedAt: '2026-11-25T10:00:00.000Z',
      timestampAt: null,
      nameMismatch: false,
    };
    expect(signSignatureInfoSchema.parse(row)).toMatchObject({ kind: 'signature', qualified: true });
    expect(signSignatureInfoSchema.safeParse({ ...row, kind: 'stamp' }).success).toBe(false);
  });

  it('takes a level when adding a recipient, and leaves it optional', () => {
    const base = { name: 'Ann', email: 'ann@example.com' };
    expect(createRecipientSchema.parse({ ...base, signatureLevel: 'aes' }).signatureLevel).toBe('aes');
    expect(createRecipientSchema.parse(base).signatureLevel).toBeUndefined();
    expect(createRecipientSchema.safeParse({ ...base, signatureLevel: 'gold' }).success).toBe(false);
  });
});
