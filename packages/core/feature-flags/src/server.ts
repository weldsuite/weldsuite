/**
 * Server-side flag evaluation for Cloudflare Workers (Hono), backed by
 * Cloudflare Flagship (https://developers.cloudflare.com/flagship/).
 *
 * Flags are evaluated through the Worker `FLAGSHIP` binding:
 *
 *     env.FLAGSHIP.getBooleanValue(key, default, context)
 *
 * which runs inside the Cloudflare network and does its own edge caching, so
 * there is no CDN fetch / KV cache to manage here.
 *
 * When the binding is absent — local `wrangler dev`, which has no Flagship
 * binding configured — every flag resolves to its catalog default. This
 * mirrors the previous "blank client key → all defaults" behaviour, so the
 * platform UI stays in its safe default state locally.
 *
 * Targeting attributes are attached per evaluation as the Flagship evaluation
 * context, so one evaluator serves every tenant on the isolate.
 */

import { getFlagDefault, type FlagKey, type FlagValue } from './flags';
import type { FlagAttributes } from './attributes';

/**
 * Minimal structural type for the Cloudflare Flagship Worker binding. Typed
 * locally (rather than via the `@cloudflare/flagship` OpenFeature provider)
 * because Workers evaluate flags through the runtime-injected binding, not the
 * SDK. Each method takes the flag key, a default returned on miss/error, and an
 * optional evaluation (targeting) context.
 */
export interface FlagshipBinding {
  getBooleanValue(
    key: string,
    defaultValue: boolean,
    context?: Record<string, unknown>,
  ): Promise<boolean>;
  getStringValue(
    key: string,
    defaultValue: string,
    context?: Record<string, unknown>,
  ): Promise<string>;
  getNumberValue(
    key: string,
    defaultValue: number,
    context?: Record<string, unknown>,
  ): Promise<number>;
  getObjectValue<T = unknown>(
    key: string,
    defaultValue: T,
    context?: Record<string, unknown>,
  ): Promise<T>;
}

interface MinimalEnv {
  FLAGSHIP?: FlagshipBinding;
  ENVIRONMENT?: string;
}

/**
 * Structural shape of the Hono context bits getFlags reads. We accept any
 * Context whose env has these fields and whose `get` can be called with
 * 'userId' / 'workspaceId' / 'orgId' — broader typings (like app-api's
 * full Variables) satisfy this constraint covariantly.
 */
export interface FlagsContext {
  env: MinimalEnv;
  get(key: 'userId'): string | undefined;
  get(key: 'workspaceId'): string | undefined;
  get(key: 'orgId'): string | null | undefined;
}

export interface FlagEvaluator {
  isOn<K extends FlagKey>(
    key: K & (FlagValue<K> extends boolean ? K : never),
    overrides?: Partial<FlagAttributes>,
  ): Promise<boolean>;
  getValue<K extends FlagKey>(
    key: K,
    overrides?: Partial<FlagAttributes>,
  ): Promise<FlagValue<K>>;
}

export type FlagContext = FlagEvaluator;

/**
 * Resolve a flag evaluator for the current request. The middleware in
 * `apps/workers/app-api/src/middleware/feature-flags.ts` calls this once per request
 * and stashes the result on `c.set('flags', evaluator)`.
 *
 * Evaluation is async — Flagship's binding returns promises — so callers do
 * `await c.get('flags').isOn('some-flag')`.
 */
export async function getFlags(c: FlagsContext): Promise<FlagEvaluator> {
  const env = c.env;
  const flagship = env.FLAGSHIP;

  const baseAttributes: FlagAttributes = {
    userId: c.get('userId') ?? '',
    workspaceId: c.get('workspaceId') ?? c.get('orgId') ?? '',
    plan: 'unknown',
    role: '',
    environment:
      (env.ENVIRONMENT as FlagAttributes['environment'] | undefined) ?? 'production',
    app: 'app-api',
  };

  const evalContext = (overrides?: Partial<FlagAttributes>): Record<string, unknown> =>
    overrides ? { ...baseAttributes, ...overrides } : { ...baseAttributes };

  return {
    async isOn(key, overrides) {
      const fallback = getFlagDefault(key) as boolean;
      if (!flagship) return fallback;
      try {
        return await flagship.getBooleanValue(key as string, fallback, evalContext(overrides));
      } catch (err) {
        console.warn('[feature-flags] Flagship getBooleanValue failed', key, err);
        return fallback;
      }
    },
    async getValue(key, overrides) {
      const fallback = getFlagDefault(key);
      if (!flagship) return fallback;
      const ctx = evalContext(overrides);
      try {
        if (typeof fallback === 'boolean') {
          return (await flagship.getBooleanValue(
            key as string,
            fallback,
            ctx,
          )) as FlagValue<typeof key>;
        }
        if (typeof fallback === 'string') {
          return (await flagship.getStringValue(
            key as string,
            fallback,
            ctx,
          )) as FlagValue<typeof key>;
        }
        if (typeof fallback === 'number') {
          return (await flagship.getNumberValue(
            key as string,
            fallback,
            ctx,
          )) as FlagValue<typeof key>;
        }
        return (await flagship.getObjectValue(
          key as string,
          fallback,
          ctx,
        )) as FlagValue<typeof key>;
      } catch (err) {
        console.warn('[feature-flags] Flagship getValue failed', key, err);
        return fallback;
      }
    },
  };
}
