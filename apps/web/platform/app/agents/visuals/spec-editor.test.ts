import { describe, expect, it } from 'vitest';
import { chatVisualSchema } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { EXAMPLES, EXAMPLE_ORDER } from './examples';
import { readSpec, specText } from './spec-editor';

describe('gallery examples', () => {
  it.each(EXAMPLE_ORDER)('%s is a spec the AI could send', (key) => {
    expect(chatVisualSchema.safeParse(EXAMPLES[key]).success).toBe(true);
  });

  it('lists every example once', () => {
    expect([...EXAMPLE_ORDER].sort()).toEqual(Object.keys(EXAMPLES).sort());
  });
});

describe('readSpec', () => {
  it('reads a valid spec back', () => {
    expect(readSpec(specText(EXAMPLES.bar))).toEqual({ ok: true, visual: EXAMPLES.bar });
  });

  it('explains what is wrong', () => {
    const result = readSpec(JSON.stringify({ ...EXAMPLES.bar, labels: ['only one'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain('one per label');
  });

  it('reports broken JSON', () => {
    expect(readSpec('{ "type": ').ok).toBe(false);
  });
});
