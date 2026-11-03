import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import { RESCANNABLE_STATUSES, documentFileUrl, processErrorMessage } from './document-actions';

const messages = { insufficientCredits: 'Not enough AI credits', fallback: 'Unknown error' };

describe('processErrorMessage', () => {
  it('says the workspace is out of credits on a 402', () => {
    const err = new ApiError('Insufficient credits', 402);
    expect(processErrorMessage(err, messages)).toBe('Not enough AI credits');
  });

  it("keeps another API error's message", () => {
    const err = new ApiError('AI request failed', 502);
    expect(processErrorMessage(err, messages)).toBe('AI request failed');
  });

  it('falls back when there is no message', () => {
    expect(processErrorMessage('boom', messages)).toBe('Unknown error');
    expect(processErrorMessage(new Error(''), messages)).toBe('Unknown error');
  });
});

describe('documentFileUrl', () => {
  it('points at the private storage route and encodes each path segment', () => {
    expect(documentFileUrl('org_1/weldbooks/documents/my invoice #1.png', 'https://app-api.example.org/')).toBe(
      'https://app-api.example.org/api/storage/private/org_1/weldbooks/documents/my%20invoice%20%231.png',
    );
  });
});

describe('RESCANNABLE_STATUSES', () => {
  it('offers a scan only for documents without an OCR result', () => {
    expect([...RESCANNABLE_STATUSES].sort()).toEqual(['failed', 'pending']);
    expect(RESCANNABLE_STATUSES.has('processed')).toBe(false);
  });
});
