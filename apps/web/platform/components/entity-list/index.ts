// Re-export shim — the canonical implementation lives in
// `packages/design/weldmeet-ui/src/components/entity-list/`. Both the platform's
// EntityList consumers and the shared weldmeet PeopleEntityListPanel resolve
// to the same source. Edit the shared files to change behavior — every
// consumer in the monorepo picks it up.
export {
  EntityList,
  FilterPills,
  EmptyStateIllustration,
} from '@weldsuite/weldmeet-ui';
export type {
  ColumnDef,
  HeaderColumn,
  FilterConfig,
  
  ActiveFilter,
  GroupConfig,
  RowHandlers,
  
  
  SortState,
} from '@weldsuite/weldmeet-ui';
