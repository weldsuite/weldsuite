import { describe, it, expect } from 'vitest';

import { isModelSupported, knownCanonicalIds, resolveModelId } from './model-map.js';
import { MODEL_PRICES } from './billing-rates.js';
import { recommended, thirdParty, workersAi } from './models.js';

describe('resolveModelId — cloudflare', () => {
  it('is an identity map (canonical ids ARE cloudflare ids)', () => {
    for (const id of knownCanonicalIds()) {
      expect(resolveModelId(id, 'cloudflare')).toBe(id);
    }
  });

  it('passes Workers AI ids through untouched', () => {
    expect(resolveModelId(workersAi.llama70bFast, 'cloudflare')).toBe(workersAi.llama70bFast);
  });

  it('passes unknown ids through unchanged — the catalog moves faster than this table', () => {
    expect(resolveModelId('some/brand-new-model', 'cloudflare')).toBe('some/brand-new-model');
  });

  it('defaults the provider to cloudflare', () => {
    expect(resolveModelId(thirdParty.anthropic.sonnet)).toBe(thirdParty.anthropic.sonnet);
  });
});

describe('isModelSupported', () => {
  it('cloudflare serves every model in the vocabulary', () => {
    expect(isModelSupported(thirdParty.anthropic.sonnet, 'cloudflare')).toBe(true);
    expect(isModelSupported(workersAi.llama70bFast, 'cloudflare')).toBe(true);
    expect(isModelSupported('some/brand-new-model')).toBe(true);
  });
});

describe('cross-checks against the rest of the package', () => {
  // Canonical == cloudflare ids: every mapped canonical id must be priceable.
  it('every canonical id in the map has a published price', () => {
    const unpriced = knownCanonicalIds().filter((id) => !MODEL_PRICES[id]);
    expect(unpriced).toEqual([]);
  });

  it('every recommended.quality model resolves on cloudflare', () => {
    for (const task of Object.values(recommended)) {
      expect(() => resolveModelId(task.quality, 'cloudflare')).not.toThrow();
    }
  });
});
