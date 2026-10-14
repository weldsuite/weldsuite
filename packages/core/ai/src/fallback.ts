/**
 * Model fallback — keep AI features working when a third-party provider refuses.
 *
 * Third-party models (`anthropic/…`, `openai/…`) are paid for with a provider
 * key stored in the gateway (BYOK) or with Unified Billing credit. When that
 * runs dry — or the key is revoked, or the provider is overloaded — the call
 * fails before any output. Instead of failing the feature, the wrapped model
 * re-runs the same call on the fallback model (Workers AI by default).
 *
 * This lives at the MODEL level (AI SDK middleware) rather than in
 * `runWithFallback` because most call sites use `ai.model(id)` directly with
 * generateText / generateObject / streamText; middleware covers all of them,
 * streaming included (a refused request fails at `doStream`, before the first
 * chunk, so it can still be retried).
 *
 * Billing: the customer must be charged for the model that actually answered.
 * The fallback result carries `providerMetadata.weldsuite.servedModelId`; call
 * sites pass the result through {@link billedModelId} when charging.
 */

import { APICallError, wrapLanguageModel, type LanguageModel, type ProviderMetadata } from 'ai';

import { unwrapGatewayError } from './errors.js';

/** `providerMetadata` key the fallback result is tagged under. */
export const FALLBACK_METADATA_KEY = 'weldsuite';

const PROVIDER_REFUSAL = /credit balance|insufficient (?:credit|funds|balance|quota)|billing|quota exceeded|overloaded/i;

/**
 * Did the provider refuse the call for a reason another model may not hit:
 * out of credit, auth, rate limit, overload, or a provider-side error?
 * Bad requests (malformed prompt/schema) are NOT fallback-worthy — they'd fail
 * the same way on the fallback model, or worse, succeed with a different answer
 * shape than the caller validated for.
 */
export function isProviderRefusal(err: unknown): boolean {
  const error = unwrapGatewayError(err);
  if (!APICallError.isInstance(error)) return false;
  const status = error.statusCode;
  if (status !== undefined && (status >= 500 || [401, 402, 403, 429].includes(status))) return true;
  // Anthropic reports an exhausted credit balance as a 400.
  const detail = `${error.message} ${error.responseBody ?? ''}`;
  return PROVIDER_REFUSAL.test(detail);
}

interface FallbackMetadata {
  servedModelId: string;
  fallbackFrom: string;
}

function tag(metadata: ProviderMetadata | undefined, info: FallbackMetadata): ProviderMetadata {
  return {
    ...(metadata ?? {}),
    [FALLBACK_METADATA_KEY]: { servedModelId: info.servedModelId, fallbackFrom: info.fallbackFrom },
  };
}

/**
 * Wrap `primary` so a provider refusal re-runs the call on `fallback`.
 * `primaryId` / `fallbackId` are canonical ids (logged + tagged on the result).
 */
export function withModelFallback(params: {
  primary: LanguageModel;
  fallback: LanguageModel;
  primaryId: string;
  fallbackId: string;
}): LanguageModel {
  // Normalise both to the current model spec so we can call doGenerate/doStream.
  const fallback = wrapLanguageModel({ model: params.fallback as never, middleware: [] });
  const info: FallbackMetadata = { servedModelId: params.fallbackId, fallbackFrom: params.primaryId };
  const warn = (err: unknown) =>
    console.warn(
      `[@weldsuite/ai] "${params.primaryId}" refused the call ` +
        `(${err instanceof Error ? err.message : String(err)}); falling back to "${params.fallbackId}".`,
    );

  return wrapLanguageModel({
    model: params.primary as never,
    middleware: {
      wrapGenerate: async ({ doGenerate, params: callParams }) => {
        try {
          return await doGenerate();
        } catch (err) {
          if (!isProviderRefusal(err)) throw err;
          warn(err);
          const result = await fallback.doGenerate(callParams);
          return { ...result, providerMetadata: tag(result.providerMetadata, info) };
        }
      },
      wrapStream: async ({ doStream, params: callParams }) => {
        try {
          return await doStream();
        } catch (err) {
          if (!isProviderRefusal(err)) throw err;
          warn(err);
          const result = await fallback.doStream(callParams);
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  controller.enqueue(
                    part.type === 'finish'
                      ? { ...part, providerMetadata: tag(part.providerMetadata, info) }
                      : part,
                  );
                },
              }),
            ),
          };
        }
      },
    },
  });
}

/**
 * The canonical model id to charge a call to: the fallback model when the
 * call fell back, otherwise the one requested. Pass the generateText /
 * generateObject result, or the streamText `onFinish` event.
 */
export function billedModelId(
  requestedModelId: string,
  result: { providerMetadata?: ProviderMetadata | undefined } | null | undefined,
): string {
  const served = result?.providerMetadata?.[FALLBACK_METADATA_KEY]?.servedModelId;
  return typeof served === 'string' && served.length > 0 ? served : requestedModelId;
}
