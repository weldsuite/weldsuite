
import { useVariables, type WorkflowVariable } from '@/hooks/queries/use-automation-queries';
import { VariablesClient } from './components/variables-client';

// The stored entity represents scope via `isGlobal` + `workflowId`, not a
// literal `scope` field — derive the client's display scope from those.
function deriveScope(v: WorkflowVariable): 'global' | 'workflow' | 'execution' {
  if (v.isGlobal) return 'global';
  if (v.workflowId) return 'workflow';
  return 'execution';
}

export default function VariablesPage() {
  const { data: variablesResult } = useVariables();

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

  return <VariablesClient initialVariables={mappedVariables} />;
}
