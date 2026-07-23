/**
 * Gateway routing — which gateway should serve this call, and in what order.
 *
 * WeldSuite runs a single gateway (Cloudflare), so ranking always yields at most
 * one candidate. The machinery is kept intact — it's what feeds the ops ledger
 * the cost factor and "covered by service credit" flag on every call, and it's
 * the seam a second gateway would slot into.
 *
 * ## Why there is no per-model price matrix here
 *
 * The gateway charges provider list price with 0% token markup (plus a flat 5%
 * fee on Cloudflare Unified Billing credit purchases). So "cheapest gateway for
 * model X" is not a per-model question, and no pre-call token estimate is needed
 * to rank candidates — which keeps this module pure and cheap.
 *
 * Pure: no env reads, no DB, no ambient clock. Everything comes in as arguments
 * so the ordering is deterministic and unit-testable.
 */

import type { GatewayProvider } from './adapters/types.js';
import type { WeldAiConfig } from './config.js';
import { isModelSupported, resolveModelId } from './model-map.js';

/**
 * Flat cost multiplier over provider list price, per gateway.
 *
 * Cloudflare's 5% is the Unified Billing credit-purchase fee — inference itself
 * is passed through at list price.
 */
export const GATEWAY_FEE_MULTIPLIER: Record<GatewayProvider, number> = {
  cloudflare: 1.05,
};

/**
 * How much freedom the router has.
 *
 * `off` is the default: the single gateway named by `AI_GATEWAY_PROVIDER`, no
 * fallback. With one gateway configured, every mode collapses to the same result.
 */
export type RoutingMode = 'off' | 'fallback' | 'cost';

export const ROUTING_MODES: readonly RoutingMode[] = ['off', 'fallback', 'cost'];

/** What a call needs a model for. */
export type ModelKind = 'language' | 'embedding';

/**
 * A gateway's ops service-credit state, as the router sees it.
 *
 * Normally read from the KV snapshot the rollup cron publishes; the router never
 * queries the DB per call.
 */
export interface GatewayCreditState {
  gateway: GatewayProvider;
  /**
   * Remaining ops credit in nano-USD. `null` = unlimited / not credit-modelled.
   * `<= 0` = exhausted.
   */
  remainingNanoUsd: number | null;
  /** Ops kill switch. A disabled gateway is never selected. */
  enabled: boolean;
  /** Lower wins among free gateways. */
  priority: number;
}

export interface GatewayCandidate {
  gateway: GatewayProvider;
  config: WeldAiConfig;
  /** The gateway-native model id — already translated. */
  nativeModelId: string;
  /** Covered by unexhausted ops service credit → effectively $0. */
  free: boolean;
  /** 0 when free, else {@link GATEWAY_FEE_MULTIPLIER}. Multiplies list price. */
  costFactor: number;
}

/**
 * Is this gateway currently free to us? Only meaningful in `cost` mode with a
 * credit snapshot that models the gateway.
 */
function isFree(state: GatewayCreditState | undefined): boolean {
  if (!state) return false;
  if (!state.enabled) return false;
  if (state.remainingNanoUsd === null) return true;
  return state.remainingNanoUsd > 0;
}

/**
 * Rank the gateways that can serve this call, best first.
 *
 * Filtering (a candidate must pass ALL):
 *  1. the model is supported there;
 *  2. it isn't ops-disabled;
 *  3. its env is complete (caller supplies only configured gateways).
 *
 * Ordering: free (service credit) → lower fee → pinned provider as a stable
 * tie-break. Deterministic for identical inputs.
 */
export function rankCandidates(params: {
  /** Configs for every gateway whose env is complete. */
  configured: readonly WeldAiConfig[];
  /** Canonical model id. */
  modelId: string;
  kind?: ModelKind;
  /** Credit state per gateway; omit for "no credit info" (KV miss). */
  credits?: readonly GatewayCreditState[];
  /** The `AI_GATEWAY_PROVIDER` pin — first in `off`/`fallback`, tie-break in `cost`. */
  pinned: GatewayProvider;
  mode: RoutingMode;
}): GatewayCandidate[] {
  const { configured, modelId, kind = 'language', credits = [], pinned, mode } = params;

  const creditByGateway = new Map<GatewayProvider, GatewayCreditState>(
    credits.map((c) => [c.gateway, c]),
  );

  const usable = configured.filter((config) => {
    const g = config.provider;
    if (!isModelSupported(modelId, g)) return false;
    if (creditByGateway.get(g)?.enabled === false) return false;
    return true;
  });

  const toCandidate = (config: WeldAiConfig): GatewayCandidate => {
    const g = config.provider;
    const free = mode === 'cost' && isFree(creditByGateway.get(g));
    return {
      gateway: g,
      config,
      nativeModelId: resolveModelId(modelId, g),
      free,
      costFactor: free ? 0 : GATEWAY_FEE_MULTIPLIER[g],
    };
  };

  // `off` — the pinned gateway alone, no fallback.
  if (mode === 'off') {
    const only = usable.find((c) => c.provider === pinned);
    return only ? [toCandidate(only)] : [];
  }

  const candidates = usable.map(toCandidate);

  // `fallback` — availability only. Pinned first, everyone else after.
  if (mode === 'fallback') {
    return candidates.sort((a, b) => rankPinned(a, b, pinned));
  }

  // `cost` — free first, then cheapest fee, then the pin as a stable tie-break.
  return candidates.sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    if (a.free && b.free) {
      const pa = creditByGateway.get(a.gateway)?.priority ?? 100;
      const pb = creditByGateway.get(b.gateway)?.priority ?? 100;
      if (pa !== pb) return pa - pb;
    }
    if (a.costFactor !== b.costFactor) return a.costFactor - b.costFactor;
    return rankPinned(a, b, pinned);
  });
}

function rankPinned(a: GatewayCandidate, b: GatewayCandidate, pinned: GatewayProvider): number {
  if (a.gateway === b.gateway) return 0;
  if (a.gateway === pinned) return -1;
  if (b.gateway === pinned) return 1;
  // Total order, so sort() is stable across engines. (Unreachable with a single
  // gateway; `String()` keeps it typed if a second one is reintroduced.)
  return String(a.gateway).localeCompare(String(b.gateway));
}

/**
 * What one call actually cost us: list price × the gateway's factor.
 * `0` when ops service credit covered it.
 */
export function effectiveCostUsd(listPriceUsd: number, candidate: GatewayCandidate): number {
  return listPriceUsd * candidate.costFactor;
}
