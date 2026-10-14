'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceAgentModel } from '@weldsuite/app-api-client/schemas/workspace-agents';
import type { AgentWithRuns } from '@/hooks/queries/use-agent-queries';
import { useUpdateAgent } from '@/hooks/queries/use-agent-queries';
import { resolveModelId } from '../agent-state';

export interface AgentFormValues {
  name: string;
  description: string;
  systemPrompt: string;
  modelId: WorkspaceAgentModel;
  permissions: string[];
}

function fromAgent(agent: AgentWithRuns): AgentFormValues {
  return {
    name: agent.name,
    description: agent.description ?? '',
    systemPrompt: agent.systemPrompt,
    modelId: resolveModelId(agent.modelId),
    permissions: [...(agent.permissions ?? [])].sort(),
  };
}

function same(a: AgentFormValues, b: AgentFormValues): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.systemPrompt === b.systemPrompt &&
    a.modelId === b.modelId &&
    a.permissions.join('|') === b.permissions.join('|')
  );
}

/**
 * The settings sheet's editable agent fields. Server refetches (a setup
 * finishing in chat, window focus) only replace the form while it has no
 * unsaved edits.
 */
export function useAgentForm(agent: AgentWithRuns) {
  const update = useUpdateAgent(agent.id);
  const [values, setValues] = useState<AgentFormValues>(() => fromAgent(agent));
  const synced = useRef<{ id: string; values: AgentFormValues }>({ id: agent.id, values: fromAgent(agent) });

  const dirty = !same(synced.current.values, values);

  useEffect(() => {
    const next = fromAgent(agent);
    const prev = synced.current;
    if (prev.id === agent.id && !same(prev.values, values)) return;
    synced.current = { id: agent.id, values: next };
    setValues(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync only on server changes
  }, [agent]);

  const set = useCallback(<K extends keyof AgentFormValues>(key: K, value: AgentFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: key === 'permissions' ? [...(value as string[])].sort() : value }));
  }, []);

  const reset = useCallback(() => setValues(synced.current.values), []);

  const save = useCallback(async () => {
    const res = await update.mutateAsync({
      name: values.name.trim() || agent.name,
      description: values.description.trim() || null,
      systemPrompt: values.systemPrompt,
      modelId: values.modelId,
      permissions: values.permissions,
    });
    const saved = (res as { data?: AgentWithRuns } | undefined)?.data;
    const next = saved ? fromAgent({ ...agent, ...saved }) : values;
    synced.current = { id: agent.id, values: next };
    setValues(next);
  }, [agent, update, values]);

  return { values, set, dirty, reset, save, saving: update.isPending };
}

export type AgentForm = ReturnType<typeof useAgentForm>;
