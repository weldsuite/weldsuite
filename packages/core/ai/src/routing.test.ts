import { describe, it, expect } from 'vitest';

import type { GatewayProvider } from './adapters/types.js';
import { configuredGateways, resolveGatewayOrder, resolveRoutingMode } from './config.js';
import { rankCandidates, type GatewayCreditState } from './routing.js';
import { thirdParty, workersAi } from './models.js';

const CF_ENV = { CF_ACCOUNT_ID: 'acct_test', AI_GATEWAY_API_TOKEN: 'cf_token' };

const configured = () => configuredGateways(CF_ENV);

function credit(gateway: GatewayProvider, over: Partial<GatewayCreditState> = {}): GatewayCreditState {
  return { gateway, remainingNanoUsd: null, enabled: true, priority: 100, ...over };
}

function rank(opts: {
  modelId?: string;
  kind?: 'language' | 'embedding';
  credits?: GatewayCreditState[];
  mode?: 'off' | 'fallback' | 'cost';
}) {
  return rankCandidates({
    configured: configured(),
    modelId: opts.modelId ?? thirdParty.anthropic.sonnet,
    kind: opts.kind,
    credits: opts.credits,
    pinned: 'cloudflare',
    mode: opts.mode ?? 'off',
  }).map((c) => c.gateway);
}

describe('routing — single gateway', () => {
  it('always resolves to cloudflare, in every mode', () => {
    expect(rank({ mode: 'off' })).toEqual(['cloudflare']);
    expect(rank({ mode: 'fallback' })).toEqual(['cloudflare']);
    expect(rank({ mode: 'cost' })).toEqual(['cloudflare']);
  });

  it('serves Workers AI (@cf/*) models', () => {
    expect(rank({ modelId: workersAi.llama70bFast })).toEqual(['cloudflare']);
  });

  it('returns nothing when cloudflare is not configured', () => {
    expect(
      rankCandidates({
        configured: configuredGateways({}),
        modelId: thirdParty.anthropic.sonnet,
        pinned: 'cloudflare',
        mode: 'off',
      }),
    ).toEqual([]);
  });
});

describe('resolveRoutingMode', () => {
  it('defaults to off when AI_GATEWAY_ROUTING is unset', () => {
    expect(resolveRoutingMode({})).toBe('off');
  });

  it('rejects an unknown routing mode loudly', () => {
    expect(() => resolveRoutingMode({ AI_GATEWAY_ROUTING: 'cheapest' })).toThrow(
      /Unknown AI_GATEWAY_ROUTING/i,
    );
  });
});

describe('configuredGateways', () => {
  it('lists cloudflare when configured, nothing otherwise, and never throws', () => {
    expect(configuredGateways(CF_ENV).map((c) => c.provider)).toEqual(['cloudflare']);
    expect(configuredGateways({})).toEqual([]);
  });
});

describe('candidate shape', () => {
  it('applies the 5% cloudflare fee when not free', () => {
    const cf = rankCandidates({
      configured: configured(),
      modelId: thirdParty.anthropic.sonnet,
      pinned: 'cloudflare',
      mode: 'cost',
    }).find((c) => c.gateway === 'cloudflare');
    expect(cf).toMatchObject({ free: false, costFactor: 1.05 });
    expect(cf!.nativeModelId).toBe(thirdParty.anthropic.sonnet);
  });

  it('carries a zero cost factor when service credit covers the call', () => {
    const [top] = rankCandidates({
      configured: configured(),
      modelId: thirdParty.anthropic.sonnet,
      credits: [credit('cloudflare')],
      pinned: 'cloudflare',
      mode: 'cost',
    });
    expect(top).toMatchObject({ gateway: 'cloudflare', free: true, costFactor: 0 });
  });

  it('never selects an ops-disabled gateway even when it has credit', () => {
    const order = rankCandidates({
      configured: configured(),
      modelId: thirdParty.anthropic.sonnet,
      credits: [credit('cloudflare', { enabled: false, remainingNanoUsd: 5_000_000_000 })],
      pinned: 'cloudflare',
      mode: 'cost',
    }).map((c) => c.gateway);
    expect(order).toEqual([]);
  });
});

describe('resolveGatewayOrder', () => {
  it('is always [cloudflare]', () => {
    expect(resolveGatewayOrder({})).toEqual(['cloudflare']);
    expect(resolveGatewayOrder({ AI_GATEWAY_ORDER: 'cloudflare' })).toEqual(['cloudflare']);
  });
});

describe('determinism', () => {
  it('produces identical ordering for identical inputs', () => {
    const args = { credits: [credit('cloudflare', { remainingNanoUsd: 1 })], mode: 'cost' as const };
    expect(rank(args)).toEqual(rank(args));
  });
});
