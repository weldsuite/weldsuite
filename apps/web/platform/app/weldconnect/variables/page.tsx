
import { useVariables } from '@/hooks/queries/use-automation-queries';
import { VariablesClient } from './components/variables-client';

export default function VariablesPage() {
  const { data: variablesResult } = useVariables();

  const variables = variablesResult?.data ?? [];

  // Map to client format
  const mappedVariables = variables.map((v: any) => ({
    id: v.id,
    name: v.name,
    description: v.description,
    value: v.value,
    type: v.type || 'string',
    scope: v.scope as 'global' | 'workflow' | 'execution',
    isSecret: v.isSecret || false,
    workflowId: v.workflowId,
    createdAt: v.createdAt,
  }));

  return <VariablesClient initialVariables={mappedVariables} />;
}
