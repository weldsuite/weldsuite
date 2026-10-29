/**
 * Writes envelopes.json: entity-event hub messages built by the TypeScript
 * publisher (`packages/core/entity-events/src/publisher.ts`) from fixed
 * inputs, for the weldsuite-events golden test.
 *
 *   pnpm exec tsx rust/crates/events/tests/fixtures/generate-envelopes.mts
 *
 * The random event id and the clock are pinned per case (`idBytes`, `nowMs`)
 * so the Rust side can build the same message and compare it byte for byte.
 * Object keys in the inputs are sorted, because serde_json writes maps in key
 * order and `JSON.stringify` in insertion order. Rerun it and commit the JSON
 * whenever the envelope, the scrubbed keys or a case changes.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALL_SENSITIVE_KEYS } from '../../../../../packages/core/db/src/lib/sensitive-columns';
import { publishCustomObjectEvent } from '../../../../../packages/core/entity-events/src/custom-objects';
import {
  publishEntityEvent,
  publishEntityEventRaw,
} from '../../../../../packages/core/entity-events/src/publisher';

// ---------------------------------------------------------------------------
// Pinned randomness and clock
// ---------------------------------------------------------------------------

let idBytes: number[] = [];
let nowMs = 0;

Object.defineProperty(globalThis.crypto, 'getRandomValues', {
  configurable: true,
  value: <T extends ArrayBufferView>(array: T): T => {
    (array as unknown as Uint8Array).set(idBytes.slice(0, (array as unknown as Uint8Array).length));
    return array;
  },
});

const RealDate = Date;
class PinnedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs);
    else super(...(args as [string]));
  }
  static override now(): number {
    return nowMs;
  }
}
globalThis.Date = PinnedDate as DateConstructor;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

type Kind = 'context' | 'raw' | 'customObject';

interface Input {
  workspaceId?: string;
  clerkOrgId?: string;
  userId: string;
  entityType: string;
  action: string;
  entityId: string;
  data: Record<string, unknown>;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  accessUserIds?: string[];
  source?: 'web' | 'mobile' | 'api' | 'system';
  workflowDepth?: number;
}

interface Case {
  name: string;
  kind: Kind;
  idBytes: number[];
  nowMs: number;
  input: Input;
}

const cases: Case[] = [
  {
    name: 'request publish uses the Clerk org id and source api',
    kind: 'context',
    idBytes: [0, 1, 2, 3, 4, 5, 6, 255],
    nowMs: 1_800_000_000_123,
    input: {
      workspaceId: 'ws_m1x2k3l4a8b9c0d1',
      clerkOrgId: 'org_2abc',
      userId: 'user_2abc',
      entityType: 'knowledge_page',
      action: 'created',
      entityId: 'kp_1',
      data: { id: 'kp_1', parentId: null, spaceId: 'ks_1', title: 'Untitled' },
    },
  },
  {
    name: 'request publish without an org id falls back to workspaces.id',
    kind: 'context',
    idBytes: [16, 32, 48, 64, 80, 96, 112, 128],
    nowMs: 1_800_000_000_000,
    input: {
      workspaceId: 'ws_m1x2k3l4a8b9c0d1',
      userId: 'user_2abc',
      entityType: 'knowledge_space',
      action: 'deleted',
      entityId: 'ks_1',
      data: { id: 'ks_1' },
    },
  },
  {
    name: 'changes, access list and an explicit source',
    kind: 'context',
    idBytes: [171, 205, 239, 1, 35, 69, 103, 137],
    nowMs: 1_767_225_599_999,
    input: {
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      userId: 'user_1',
      entityType: 'knowledge_page',
      action: 'updated',
      entityId: 'kp_2',
      data: { id: 'kp_2', nested: { list: [1, 'two', true, null], n: 1.5 }, title: 'New' },
      changes: { title: { new: 'New', old: 'Old' } },
      accessUserIds: ['user_1', 'user_2'],
      source: 'web',
    },
  },
  {
    name: 'null changes and an empty access list are left out',
    kind: 'context',
    idBytes: [9, 9, 9, 9, 9, 9, 9, 9],
    nowMs: 1_800_000_000_001,
    input: {
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      userId: 'user_1',
      entityType: 'knowledge_space_member',
      action: 'removed',
      entityId: 'ks_1',
      data: { spaceId: 'ks_1', userId: 'user_9' },
      changes: null,
      accessUserIds: [],
    },
  },
  {
    name: 'raw publish defaults to source system and carries the workflow depth',
    kind: 'raw',
    idBytes: [255, 254, 253, 252, 251, 250, 249, 248],
    nowMs: 1_800_000_000_500,
    input: {
      workspaceId: 'org_raw',
      userId: 'system',
      entityType: 'customer',
      action: 'created',
      entityId: 'cus_1',
      data: { id: 'cus_1', name: 'Acme' },
      workflowDepth: 2,
    },
  },
  {
    name: 'workflow depth zero is kept',
    kind: 'raw',
    idBytes: [1, 1, 1, 1, 1, 1, 1, 1],
    nowMs: 1_800_000_000_501,
    input: {
      workspaceId: 'org_raw',
      userId: 'user_1',
      entityType: 'customer',
      action: 'archived',
      entityId: 'cus_1',
      data: { id: 'cus_1' },
      source: 'api',
      workflowDepth: 0,
    },
  },
  {
    name: 'sensitive columns are scrubbed at any depth, in data and changes',
    kind: 'context',
    idBytes: [222, 173, 190, 239, 0, 0, 0, 1],
    nowMs: 1_800_000_000_777,
    input: {
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      userId: 'user_1',
      entityType: 'customer',
      action: 'updated',
      entityId: 'cus_2',
      data: {
        accounts: [
          { accountNumberEncrypted: 'x', last4: '1234' },
          { credentialsEncrypted: 'x', id: 'bc_1' },
          'plain',
        ],
        id: 'cus_2',
        party: { name: 'Acme', sensitiveEncrypted: 'x', ssnEncrypted: 'x' },
        sensitiveEncrypted: 'x',
        smtpCredentials: { password: 'x' },
      },
      changes: {
        accountNumberEncrypted: { new: 'b', old: 'a' },
        name: { new: 'Acme', old: 'Acme Inc' },
      },
    },
  },
  {
    name: 'custom object records publish as co_<slug>',
    kind: 'customObject',
    idBytes: [7, 6, 5, 4, 3, 2, 1, 0],
    nowMs: 1_800_000_000_999,
    input: {
      workspaceId: 'ws_1',
      clerkOrgId: 'org_1',
      userId: 'user_1',
      entityType: 'co_machine',
      action: 'created',
      entityId: 'cor_1',
      data: { fields: { serial: 'A-1' }, id: 'cor_1' },
    },
  },
];

// ---------------------------------------------------------------------------
// Run each case through the real publisher and capture the hub message
// ---------------------------------------------------------------------------

async function run(testCase: Case): Promise<unknown> {
  const sent: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const env = {
    ENTITY_EVENTS: {
      send: async (message: unknown) => {
        sent.push(message);
      },
    },
  };
  const { input } = testCase;
  const variables: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    clerkOrgId: input.clerkOrgId,
    userId: input.userId,
  };
  const c = {
    env,
    get: (key: string) => variables[key],
    executionCtx: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
  };

  idBytes = testCase.idBytes;
  nowMs = testCase.nowMs;

  const common = {
    entityId: input.entityId,
    action: input.action,
    data: input.data,
    changes: input.changes,
    accessUserIds: input.accessUserIds,
    source: input.source,
  };
  if (testCase.kind === 'context') {
    publishEntityEvent({ c, entityType: input.entityType, ...common } as never);
  } else if (testCase.kind === 'customObject') {
    publishCustomObjectEvent({ c, entityKey: input.entityType, ...common } as never);
  } else {
    await publishEntityEventRaw({
      env,
      workspaceId: input.workspaceId ?? '',
      userId: input.userId,
      entityType: input.entityType,
      workflowDepth: input.workflowDepth,
      ...common,
    } as never);
  }
  await Promise.all(pending);

  if (sent.length !== 1) throw new Error(`${testCase.name}: expected one message, got ${sent.length}`);
  return sent[0];
}

const output = {
  sensitiveKeys: [...ALL_SENSITIVE_KEYS].sort(),
  cases: [] as unknown[],
};
for (const testCase of cases) {
  const message = await run(testCase);
  output.cases.push({ ...testCase, json: JSON.stringify(message) });
}

const here = path.dirname(fileURLToPath(import.meta.url));
writeFileSync(path.join(here, 'envelopes.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${output.cases.length} cases to ${path.join(here, 'envelopes.json')}`);
