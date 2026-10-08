
import { useVariables, type WorkflowVariable } from '@/hooks/queries/use-automation-queries';
import { VariablesClient } from './components/variables-client';
import { useVariableWorkflows } from './use-variable-workflows';

// The list reports each row's `scope`; a row without a workflowId is global
// (that is how the workflow engine reads it).
function deriveScope(v: WorkflowVariable): 'global' | 'workflow' {
  return v.scope === 'workflow' && v.workflowId ? 'workflow' : 'global';
}

export default function VariablesPage() {
  // The list filters and searches client-side, so load a full page up front.
  const { data: variablesResult, isPending } = useVariables({ limit: 100 });
  const { data: workflowsResult } = useVariableWorkflows();

  const variables = variablesResult?.data ?? [];

  // Map to client format
  const mappedVariables = variables.map((v: WorkflowVariable) => ({
    id: v.id,
    name: v.name,
    description: v.description ?? undefined,
    value: v.value,
    type: v.type || 'string',
    scope: deriveScope(v),
    isSecret: v.isSecret || false,
    workflowId: v.workflowId ?? undefined,
    createdAt: v.createdAt,
  }));

  const workflowNames: Record<string, string> = {};
  for (const w of workflowsResult?.data ?? []) workflowNames[w.id] = w.name;

  return (
    <VariablesClient initialVariables={mappedVariables} isLoading={isPending} workflowNames={workflowNames} />
  );
}
