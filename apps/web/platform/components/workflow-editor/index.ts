/**
 * Shared workflow editor — the stateful editor shell that hosts the
 * presentational `WorkflowCanvas` (from @weldsuite/ui). Neutral home so both
 * WeldConnect (workflows) and WeldCRM (sequences) consume it without reaching
 * across module boundaries. Data fetching stays app-side via
 * `@/hooks/use-workflow-editor-data`; this module is the UI + interaction layer.
 */
export {
  WorkflowEditorClient,
  
  
  
} from './workflow-editor-client';
export {
  WorkflowEditorShell,
  
  
} from './workflow-editor-shell';
