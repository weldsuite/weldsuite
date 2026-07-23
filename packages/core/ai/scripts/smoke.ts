/**
 * Live smoke test — proves the Cloudflare AI Gateway actually answers.
 *
 * The unit tests mock nothing but also call nothing: they verify config,
 * id-mapping and that a model object is constructed. Only a real request proves
 * the token, host and native model id are right.
 *
 * Usage (reads .env / your shell):
 *   pnpm --filter @weldsuite/ai smoke
 *
 * Optional: SMOKE_MODEL=<canonical id> to test a specific model.
 */

import { embed, generateText } from 'ai';

import { createWeldAI } from '../src/gateway.js';
import { UnsupportedModelError } from '../src/adapters/types.js';
import { recommended } from '../src/models.js';

async function main(): Promise<void> {
  const ai = createWeldAI(process.env);
  const modelId = process.env.SMOKE_MODEL ?? ai.config.defaultModel;

  console.log(`gateway : ${ai.gateway}`);
  console.log(`model   : ${modelId}`);

  // ── chat ────────────────────────────────────────────────────────────────
  const started = Date.now();
  const { text, usage } = await generateText({
    model: ai.model(modelId),
    prompt: 'Reply with exactly the word: pong',
  });
  console.log(`\n✓ generateText (${Date.now() - started}ms)`);
  console.log(`  reply : ${text.trim().slice(0, 80)}`);
  console.log(`  usage : in=${usage?.inputTokens ?? '?'} out=${usage?.outputTokens ?? '?'}`);

  // ── embeddings (not available on every gateway) ─────────────────────────
  const embedId = recommended.embed.free;
  try {
    const { embedding } = await embed({
      model: ai.embedding(embedId),
      value: 'WeldSuite multi-gateway smoke test',
    });
    console.log(`\n✓ embed [${embedId}] → ${embedding.length} dims`);
  } catch (err) {
    if (err instanceof UnsupportedModelError) {
      console.log(`\n· embed skipped — ${err.message.split('.')[0]}.`);
    } else {
      throw err;
    }
  }

  console.log(`\nAll good on "${ai.gateway}".`);
}

main().catch((err: unknown) => {
  console.error('\n✗ Smoke test FAILED');
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
