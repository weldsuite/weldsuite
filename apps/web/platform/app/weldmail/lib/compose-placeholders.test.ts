import { describe, expect, it } from 'vitest';
import { unfilledPlaceholders } from './compose-placeholders';

describe('unfilledPlaceholders', () => {
  it('finds the placeholders of the subject and the body, each once', () => {
    expect(unfilledPlaceholders('Hi {{first_name}}', 'Bold line two{{first_name}} at {{ company }}')).toEqual([
      '{{first_name}}',
      '{{company}}',
    ]);
  });

  it('finds none in a mail without them', () => {
    expect(unfilledPlaceholders('Hello', 'Plain {text} and {{}}', null, undefined)).toEqual([]);
  });
});
