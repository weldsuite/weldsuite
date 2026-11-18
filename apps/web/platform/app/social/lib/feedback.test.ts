import { beforeEach, describe, expect, it, vi } from 'vitest';

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error } }));

import { isMediaUrl, toastError } from './feedback';

describe('isMediaUrl', () => {
  it('takes an absolute http(s) link', () => {
    expect(isMediaUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isMediaUrl('  http://example.com/b.jpg ')).toBe(true);
  });

  it('refuses text that is not a link', () => {
    expect(isMediaUrl('not a url')).toBe(false);
    expect(isMediaUrl('')).toBe(false);
    expect(isMediaUrl('/relative/path.png')).toBe(false);
    expect(isMediaUrl('javascript:alert(1)')).toBe(false);
    expect(isMediaUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isMediaUrl('ftp://example.com/a.png')).toBe(false);
  });
});

describe('toastError', () => {
  beforeEach(() => error.mockClear());

  it("shows the API's message under what failed", () => {
    toastError('The campaign could not be saved', new Error('Failed to create social campaign'));
    expect(error).toHaveBeenCalledWith('The campaign could not be saved', {
      description: 'Failed to create social campaign',
    });
  });

  it('shows only what failed when there is nothing more to say', () => {
    toastError('The campaign could not be saved', 'not an error');
    toastError('The campaign could not be saved', new Error(''));
    expect(error).toHaveBeenNthCalledWith(1, 'The campaign could not be saved', undefined);
    expect(error).toHaveBeenNthCalledWith(2, 'The campaign could not be saved', undefined);
  });
});
