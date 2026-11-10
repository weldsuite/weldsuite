import { describe, expect, it } from 'vitest';
import { definitionTokens, extraTokens, insertAtSelection, wrapToken } from './tokens';

describe('insertAtSelection', () => {
  it('inserts at the caret', () => {
    expect(insertAtSelection('Hello !', '{{field:name}}', 6, 6)).toEqual({ value: 'Hello {{field:name}}!', caret: 20 });
  });

  it('replaces a selection', () => {
    expect(insertAtSelection('Hello world', 'X', 6, 11)).toEqual({ value: 'Hello X', caret: 7 });
  });

  it('appends when there is no selection', () => {
    expect(insertAtSelection('abc', 'X', null, null)).toEqual({ value: 'abcX', caret: 4 });
  });
});

describe('tokens', () => {
  it('wraps a token and lists the integration extras', () => {
    expect(wrapToken('form:title')).toBe('{{form:title}}');
    expect(extraTokens()).toEqual(['form:title', 'response:number', 'response:url']);
  });

  it('builds one token per question and hidden field', () => {
    const tokens = definitionTokens({
      blocks: [
        { id: 'b1', ref: 'full_name', type: 'short_text', title: 'Your name', required: false, properties: {} },
      ] as never,
      hidden: [{ name: 'utm_source' }],
    });
    expect(tokens.questions).toEqual([{ token: '{{field:full_name}}', label: 'Your name' }]);
    expect(tokens.hidden).toEqual([{ token: '{{hidden:utm_source}}', label: 'utm_source' }]);
  });
});
