/**
 * Test helper: build an ActionContext with sane defaults.
 */

import type { ActionContext, WorkflowDb, WorkflowEnv } from '../engine/types';

export function makeActionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    tenant: { workspaceId: 'ws_test', userId: 'user_test' },
    executionId: 'wex_test',
    stepId: 'step_test',
    db: (overrides.db ?? ({} as WorkflowDb)) as WorkflowDb,
    env: (overrides.env ?? ({} as WorkflowEnv)) as WorkflowEnv,
    previousResults: {},
    triggerData: {},
    variables: {},
    ...overrides,
  };
}
