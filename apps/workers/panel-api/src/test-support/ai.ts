/**
 * What the AI route tests share: the mock model of `@weldsuite/ai/testing`
 * in front of the test's other fetch stub (FakeBasin), and the master
 * database's credit wallet.
 *
 * Both backends answer the same tests in conformance mode: the model answers
 * by prompt, never by call order (the stub serves the Hono app and the Rust
 * server), so a count of model calls is per run ({@link RUNS} in ./fakes),
 * and the wallet is the real one in the master database, charged by
 * `@weldsuite/core-domain/ai-billing` (the Hono app) or the `weldsuite-ai`
 * crate (Rust): `AI (<op>) [<model>]`, at least one credit a call.
 */

import { vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { grantCredits } from '@weldsuite/credits';
import { MOCK_AI_BASE_URL, createMockModel, type MockChatReply, type MockChatRequest } from '@weldsuite/ai/testing';
import { masterSchema, type AnyMasterDatabase } from '@weldsuite/worker-kit/db';

const { workspaces, workspaceCredits, creditTransactions } = masterSchema;

/** Sends both backends' model calls to the mock model. */
export const AI_ENV = { AI_TEST_BASE_URL: MOCK_AI_BASE_URL };

/** One model call as the tests read it. */
export interface ModelCall {
  model: string;
  system: string;
  prompt: string;
}

/**
 * The mock model in front of the fetch stub installed now (FakeBasin's):
 * `reply` answers each chat call by its prompt; every call lands in `calls`.
 */
export function installModel(reply: (request: MockChatRequest) => MockChatReply, calls: ModelCall[]) {
  const mock = createMockModel(
    {
      chat: (request) => {
        calls.push({ model: request.model, system: request.system, prompt: request.messages.map((m) => m.text).join('\n') });
        return reply(request);
      },
    },
    globalThis.fetch,
  );
  vi.stubGlobal('fetch', mock.fetch);
  return mock;
}

/** The workspace in the master database, with a fresh wallet holding `credits`. */
export async function seedWallet(master: AnyMasterDatabase, workspaceId: string, clerkOrgId: string, credits: number): Promise<void> {
  await master.delete(creditTransactions).where(eq(creditTransactions.workspaceId, workspaceId));
  await master.delete(workspaceCredits).where(eq(workspaceCredits.workspaceId, workspaceId));
  await master.insert(workspaces).values({ id: workspaceId, clerkOrgId, name: 'Acme', slug: `acme-${workspaceId}` }).onConflictDoNothing();
  if (credits > 0) await grantCredits(master, { workspaceId, amount: credits, type: 'purchase', description: 'test' });
}

/** Takes the wallet down to nothing. */
export async function emptyWallet(master: AnyMasterDatabase, workspaceId: string): Promise<void> {
  await master.update(workspaceCredits).set({ currentBalance: 0 }).where(eq(workspaceCredits.workspaceId, workspaceId));
}

/** One AI charge in the wallet's ledger. */
export interface AiCharge {
  op: string;
  modelId: string;
  referenceId: string | null;
  credits: number;
}

/** The AI charges the wallet booked, oldest first. */
export async function aiCharges(master: AnyMasterDatabase, workspaceId: string): Promise<AiCharge[]> {
  const rows = await master
    .select()
    .from(creditTransactions)
    .where(and(eq(creditTransactions.workspaceId, workspaceId), eq(creditTransactions.type, 'consumption'), eq(creditTransactions.serviceType, 'ai_tokens')))
    .orderBy(creditTransactions.createdAt);
  return rows.map((row) => {
    const [, op = '', modelId = ''] = /^AI \(([^)]*)\) \[([^\]]*)\]/.exec(row.description ?? '') ?? [];
    return { op, modelId, referenceId: row.referenceId, credits: -row.amount };
  });
}
