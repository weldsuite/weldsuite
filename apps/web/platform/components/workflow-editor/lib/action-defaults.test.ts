import { describe, expect, it } from 'vitest';
import { getMissingRequiredFields } from '@weldsuite/ui/components/workflow-canvas';
import { withActionDefaults } from './action-defaults';

describe('withActionDefaults', () => {
  it('stores the method the HTTP form displays by default', () => {
    expect(withActionDefaults('http_request')).toEqual({ method: 'GET' });
  });

  it('keeps values that are already set', () => {
    expect(withActionDefaults('http_request', { method: 'POST', url: 'https://x.test' })).toEqual({
      method: 'POST',
      url: 'https://x.test',
    });
  });

  it('fills blank values but leaves unrelated keys alone', () => {
    expect(withActionDefaults('create_task', { priority: '', title: 'T' })).toEqual({ priority: 'medium', title: 'T' });
  });

  it('returns the config untouched for actions without displayed defaults', () => {
    const config = { to: 'a@example.com' };
    expect(withActionDefaults('send_email', config)).toBe(config);
    expect(withActionDefaults('toString', config)).toBe(config);
  });
});

describe('http_request required fields', () => {
  it('only asks for the URL: the method defaults to GET', () => {
    expect(getMissingRequiredFields('http_request', {})).toEqual([{ labelKey: 'url' }]);
    expect(getMissingRequiredFields('http_request', { url: 'https://x.test' })).toEqual([]);
    expect(getMissingRequiredFields('http_request', { url: 'https://x.test', method: 'GET' })).toEqual([]);
  });
});
