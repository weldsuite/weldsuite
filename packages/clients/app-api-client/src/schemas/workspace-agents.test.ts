import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_AGENT_MODELS,
  WORKSPACE_AGENT_POLICY_DEFAULT_MODEL,
  createWorkspaceAgentSchema,
  createWorkspaceAgentSchemaAnyModel,
  isWorkspaceAgentAnyModel,
  isWorkspaceAgentModel,
  updateWorkspaceAgentSchema,
  updateWorkspaceAgentSchemaAnyModel,
} from './workspace-agents';

describe('the agent model', () => {
  it('stays a strict Claude enum on Global', () => {
    for (const modelId of WORKSPACE_AGENT_MODELS) {
      expect(createWorkspaceAgentSchema.safeParse({ name: 'A', modelId }).success).toBe(true);
    }
    expect(createWorkspaceAgentSchema.safeParse({ name: 'A', modelId: 'mistral/mistral-large-4-0' }).success).toBe(false);
    expect(createWorkspaceAgentSchema.safeParse({ name: 'A', modelId: 'default' }).success).toBe(false);
    expect(updateWorkspaceAgentSchema.safeParse({ modelId: 'gpt-5' }).success).toBe(false);
    expect(isWorkspaceAgentModel('claude-opus-5-5')).toBe(true);
    expect(isWorkspaceAgentModel('default')).toBe(false);
  });

  it('takes any catalog model, the Claude ids and the policy default on a Kubernetes install', () => {
    const ok = ['mistral/mistral-large-4-0', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5', 'claude-haiku-5-5', WORKSPACE_AGENT_POLICY_DEFAULT_MODEL];
    for (const modelId of ok) {
      expect(createWorkspaceAgentSchemaAnyModel.safeParse({ name: 'A', modelId }).success).toBe(true);
      expect(updateWorkspaceAgentSchemaAnyModel.safeParse({ modelId }).success).toBe(true);
      expect(isWorkspaceAgentAnyModel(modelId)).toBe(true);
    }
    for (const modelId of ['', 'gpt 5', '/x', 'mistral/', 'x'.repeat(101)]) {
      expect(createWorkspaceAgentSchemaAnyModel.safeParse({ name: 'A', modelId }).success).toBe(false);
    }
    expect(isWorkspaceAgentAnyModel(null)).toBe(false);
  });
});
