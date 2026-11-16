/**
 * WeldBoard's AI actions (`POST /api/boards/:id/ai`): make a mind map, a
 * flowchart or a set of sticky notes from a prompt, group sticky notes by
 * theme, suggest more ideas next to some notes, and summarise a selection or
 * the whole board.
 *
 * The model answers in a small JSON shape (a board spec, themes, ideas or a
 * summary); the engine turns that into ops (`placeSpec`, `clusterOps`), which
 * the route commits through the board's room, so everyone in the board sees
 * the result arrive. Nothing here writes: a summary goes back to the platform,
 * which saves it in WeldDocs with the person's own access.
 *
 * What each action asks and how its answer is placed is `services/ai-plan.ts`,
 * shared with the Rust backend through the board engine (ADR AI-012). Here,
 * the call goes through @weldsuite/ai, charged per call with `chargeAiUsage`
 * for the model that served it (`billedModelId`).
 */

import { assertGatewayConfigured, billedModelId, createWeldAI, generateObject, jsonSchema, recommended, type AiUsage, type ProviderMetadata, type WeldAI } from '@weldsuite/ai';
import { assertAiCredits, chargeAiUsage, type AiMetering } from '@weldsuite/core-domain/ai-billing';
import type { Board } from '@weldsuite/board-engine';
import type { BoardAiInput } from '@weldsuite/app-api-client/schemas/boards';
import type { Env } from '../types';
import { BoardAiError, boardAiAsk, boardAiPlan, checkBoardAi, type BoardAiPlan } from './ai-plan';

export { BoardAiError, type BoardAiPlan } from './ai-plan';

function getAi(env: Env): WeldAI {
  try {
    assertGatewayConfigured(env);
  } catch (err) {
    throw new BoardAiError('AI_NOT_CONFIGURED', err instanceof Error ? err.message : 'AI is not configured', 503);
  }
  return createWeldAI(env);
}

/** Runs the action and returns the ops to commit; charges the call. */
export async function runBoardAi(
  env: Env,
  board: Board,
  input: BoardAiInput,
  ctx: { userId: string; metering: AiMetering | null; now: number },
): Promise<BoardAiPlan> {
  checkBoardAi(board, input);
  const ai = getAi(env);
  await assertAiCredits(ctx.metering);
  const ask = boardAiAsk(board, input);
  const model = recommended[ask.task].quality;
  let result: { object: unknown; usage: AiUsage; providerMetadata?: ProviderMetadata };
  try {
    const schema = jsonSchema<unknown>(ask.schema as Parameters<typeof jsonSchema>[0]);
    result = (await generateObject({ model: ai.model(model), schema, system: ask.system, prompt: ask.user })) as typeof result;
  } catch (err) {
    throw new BoardAiError('AI_REQUEST_FAILED', err instanceof Error ? err.message : 'The AI request failed', 502);
  }
  await chargeAiUsage(ctx.metering, { modelId: billedModelId(model, result), usage: result.usage, op: `board_${input.action}` });
  return boardAiPlan(board, input, result.object, { userId: ctx.userId, now: ctx.now });
}
