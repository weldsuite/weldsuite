/**
 * Sampling parameters per model.
 *
 * The Claude 5 generation (and Opus 4.7 / 4.8) reject non-default sampling
 * parameters: a `temperature`, `topP` or `topK` on the request is a 400, which
 * the fallback (fallback.ts) rightly treats as a bad request and does not
 * retry. Call sites pick models dynamically (`/api/ai/generate`, workflow AI
 * steps) and pass a temperature, so the parameters are dropped for these
 * models instead of failing the call.
 */

import { wrapLanguageModel, type LanguageModel } from 'ai';

const FIXED_SAMPLING =
  /^anthropic\/claude-(?:(?:fable|mythos)-|(?:opus|sonnet|haiku)-5(?:$|-)|opus-4-[78](?:$|-))/;

/** Does this model reject non-default temperature / topP / topK? */
export function rejectsSamplingParams(modelId: string): boolean {
  return FIXED_SAMPLING.test(modelId);
}

/** `model` with sampling parameters stripped when `modelId` rejects them. */
export function withSupportedSampling(model: LanguageModel, modelId: string): LanguageModel {
  if (!rejectsSamplingParams(modelId)) return model;
  return wrapLanguageModel({
    model: model as never,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        temperature: undefined,
        topP: undefined,
        topK: undefined,
      }),
    },
  });
}
