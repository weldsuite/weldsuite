// Shared editor-local types for the helpdesk workflow editor. The API layer
// (see hooks/queries/use-automation-queries.ts) types `triggers`/`steps` as
// `unknown[]` since the shape is genuinely dynamic across workflow modules —
// this file narrows that down to what the helpdesk editor UI actually reads.
import type { WorkflowStep, WorkflowTrigger } from './components/canvas-utils';

export interface HelpdeskWorkflow {
  id: string;
  name: string;
  description?: string;
  status?: string;
  triggers: WorkflowTrigger[];
  steps: WorkflowStep[];
}

export type { WorkflowStep, WorkflowTrigger };
