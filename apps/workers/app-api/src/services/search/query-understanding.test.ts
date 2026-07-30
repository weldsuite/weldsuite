/**
 * Unit tests for the pure tiers of search query understanding — the router,
 * the en/nl lexicon, model-output normalization, and the permission
 * intersection. No AI gateway, KV or DB involved: every function under test
 * here is deliberately side-effect free so the interesting behaviour is
 * verifiable without a model call.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldUnderstand,
  parseWithLexicon,
  normalizeModelOutput,
  applyPermittedTypes,
  passthrough,
} from './query-understanding';
import type { SearchEntityType } from '@weldsuite/app-api-client/schemas/search';

describe('shouldUnderstand', () => {
  it('skips identifiers so jump-to-record stays on the fast path', () => {
    expect(shouldUnderstand('INV-2024-0042')).toBe(false);
    expect(shouldUnderstand('TASK-1042')).toBe(false);
    expect(shouldUnderstand('#1042')).toBe(false);
    expect(shouldUnderstand('1042')).toBe(false);
    expect(shouldUnderstand('INV2024')).toBe(false);
  });

  it('treats a type noun plus a number as a scoped search, not a lookup', () => {
    // "invoice 2024" is shaped like INV-2024 but means "invoices from 2024",
    // so it must reach the parser rather than the jump-to-record fast path.
    expect(shouldUnderstand('invoice 2024')).toBe(true);
    expect(shouldUnderstand('facturen 2024')).toBe(true);
  });

  it('skips email addresses', () => {
    expect(shouldUnderstand('john@acme.nl')).toBe(false);
  });

  it('skips single tokens and bare names', () => {
    expect(shouldUnderstand('acme')).toBe(false);
    expect(shouldUnderstand('John Jansen')).toBe(false);
  });

  it('structures a two-token query when one names an entity type', () => {
    expect(shouldUnderstand('acme invoices')).toBe(true);
    expect(shouldUnderstand('facturen Jansen')).toBe(true);
  });

  it('structures anything sentence-shaped', () => {
    expect(shouldUnderstand('Invoice from Acme Corp')).toBe(true);
    expect(shouldUnderstand('tickets about the broken pump')).toBe(true);
  });

  it('ignores empty and whitespace-only input', () => {
    expect(shouldUnderstand('')).toBe(false);
    expect(shouldUnderstand('   ')).toBe(false);
  });
});

describe('parseWithLexicon', () => {
  it('resolves the motivating example with no model call', () => {
    const parsed = parseWithLexicon('Invoice from Acme Corp');
    expect(parsed).not.toBeNull();
    expect(parsed!.entityTypes).toEqual(['invoice']);
    expect(parsed!.lexicalTerm).toBe('Acme Corp');
    expect(parsed!.source).toBe('lexicon');
  });

  it('handles the Dutch phrasing of the same query', () => {
    const parsed = parseWithLexicon('factuur van Acme Corp');
    expect(parsed!.entityTypes).toEqual(['invoice']);
    expect(parsed!.lexicalTerm).toBe('Acme Corp');
  });

  it('maps Dutch plurals that an English stemmer would miss', () => {
    expect(parseWithLexicon('facturen Jansen')!.entityTypes).toEqual(['invoice']);
    expect(parseWithLexicon('taken van Piet')!.entityTypes).toEqual(['task']);
    expect(parseWithLexicon('openstaande rekeningen')!.entityTypes).toEqual(['bill']);
  });

  it('preserves the original casing of the extracted term', () => {
    expect(parseWithLexicon('ticket for ACME B.V.')!.lexicalTerm).toBe('ACME B.V.');
  });

  it('collects multiple distinct types', () => {
    const parsed = parseWithLexicon('contacts and companies at Acme');
    expect(parsed!.entityTypes.sort()).toEqual(['contact', 'customer']);
  });

  it('falls back to the raw query when the whole query is type nouns', () => {
    const parsed = parseWithLexicon('show me all invoices');
    expect(parsed!.entityTypes).toEqual(['invoice']);
    expect(parsed!.lexicalTerm).toBe('show me all invoices');
  });

  it('returns null when no entity noun is present, so the model tier runs', () => {
    expect(parseWithLexicon('who handles the Rotterdam account')).toBeNull();
    expect(parseWithLexicon('the broken pump last week')).toBeNull();
  });
});

describe('normalizeModelOutput', () => {
  it('drops entity types outside the runtime allow-list', () => {
    const parsed = normalizeModelOutput(
      { entityTypes: ['invoice', 'spaceship'], searchTerm: 'Acme', semanticQuery: 'x' },
      'invoice from Acme',
    );
    expect(parsed.entityTypes).toEqual(['invoice']);
  });

  it('deduplicates repeated types', () => {
    const parsed = normalizeModelOutput(
      { entityTypes: ['ticket', 'ticket'], searchTerm: 'pump', semanticQuery: 'x' },
      'tickets about pump',
    );
    expect(parsed.entityTypes).toEqual(['ticket']);
  });

  it('falls back to the raw query when the model returns an empty term', () => {
    const parsed = normalizeModelOutput(
      { entityTypes: ['invoice'], searchTerm: '  ', semanticQuery: '' },
      'all invoices',
    );
    expect(parsed.lexicalTerm).toBe('all invoices');
    expect(parsed.semanticQuery).toBe('all invoices');
  });

  it('tolerates entirely missing fields', () => {
    const parsed = normalizeModelOutput({}, 'something');
    expect(parsed.entityTypes).toEqual([]);
    expect(parsed.lexicalTerm).toBe('something');
  });
});

describe('applyPermittedTypes', () => {
  const permitted: SearchEntityType[] = ['invoice', 'ticket', 'contact'];

  it('narrows to the parsed types', () => {
    const parsed = passthrough('x');
    parsed.entityTypes = ['invoice'];
    expect(applyPermittedTypes(parsed, permitted)).toEqual(['invoice']);
  });

  it('never widens beyond what the caller may see', () => {
    const parsed = passthrough('x');
    parsed.entityTypes = ['invoice', 'domain'];
    expect(applyPermittedTypes(parsed, permitted)).toEqual(['invoice']);
  });

  it('searches everything permitted when the parse has no opinion', () => {
    expect(applyPermittedTypes(passthrough('acme'), permitted)).toEqual(permitted);
  });

  it('falls back to everything permitted when the intersection is empty', () => {
    const parsed = passthrough('x');
    parsed.entityTypes = ['domain'];
    expect(applyPermittedTypes(parsed, permitted)).toEqual(permitted);
  });
});
